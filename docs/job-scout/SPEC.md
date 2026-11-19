# Job Scout — Phase 1 Specification

> **Purpose of this document:** a build-ready specification to hand to Claude Code. It describes *what* to build, *how* it fits together on Cloudflare, and *how we'll know it works*. Where a decision is marked **[ASSUMPTION]**, verify it during build and adjust; everything else is a decision already made.

---

## 0. TL;DR for the implementer

Build a **single-user, fully automated UK job-matching app on Cloudflare** that:

1. **Three times a day (07:00 / 12:00 / 17:00 UK time, weekdays + Sunday 17:00)** pulls new jobs from the **Reed.co.uk Jobseeker API** using search profiles tied to **four uploaded CVs**.
2. **De-duplicates** jobs (exact and near-duplicate reposts by different agencies).
3. **Scores in two stages**: cheap hard filters + embedding similarity for everything; **Llama on Workers AI** for only the top ~30 per run, producing a 0–100 score, reasons, gaps, the best CV to use, and extracted pay/contract/contact details.
4. Shows a **ranked React dashboard** with a simple application pipeline, on-demand **tailored cover notes**, and uses Apply/Skip feedback to nudge future ranking.

**Stack:** TypeScript · Hono · Cloudflare Workers (cron + queues + static assets) · D1 · R2 · Vectorize · Workers AI · React + Vite + Tailwind · Cloudflare Access for auth.

**No scraping. No job-alert email parsing in phase 1.** Reed API only, behind a pluggable source-adapter interface so Adzuna / Jooble / RSS can be added in phase 2.

---

## 1. Goals, non-goals, success criteria

### 1.1 Goals
- Replace the manual loop of "visit several sites → read the same jobs repeatedly → paste into an AI one by one".
- Surface **fresh, relevant, de-duplicated** contract **and** permanent roles, ranked against the right CV.
- Give enough information on one card to decide **apply / skip in under 30 seconds**: score, why, gaps, pay/day rate, IR35, location/remote, agency/contact, link.
- Run **hands-off**; the user only opens the dashboard.

### 1.2 Non-goals (phase 1)
- Multi-user, sign-up, billing.
- Scraping any website, or parsing job-alert emails.
- Auto-applying to jobs.
- CV rewriting / bullet tweak suggestions (phase 2).
- Email/Telegram/push notifications (phase 2).
- Full CRM (contacts, reminders, interview calendar) (phase 2).

### 1.3 Success criteria (phase 1 is "done" when)
1. Scheduled runs fire at the configured UK local times (correct across GMT/BST changes) with no manual action.
2. A run fetches Reed jobs for every active search profile, stores only new ones, and completes in < 10 minutes.
3. The same role posted by 3 agencies appears as **one** card listing all 3 postings.
4. Each run produces at most `MAX_LLM_PER_RUN` (default 30) Llama assessments, each with a valid structured JSON result.
5. The dashboard Inbox shows new jobs ranked by final score, filterable by contract/perm, CV, min score, remote, IR35.
6. The user can move a job through the pipeline, record which CV was sent, and generate a cover note.
7. Daily Workers AI and Reed API usage stays within configured budgets; budget exhaustion degrades gracefully (logged, not crashed).

---

## 2. User & access

- **Single user.** No account system.
- **Auth:** the whole app (dashboard + API) sits behind **Cloudflare Access** (one-time PIN or Google login, policy = the owner's email only).
- The Worker **must verify** the `Cf-Access-Jwt-Assertion` header (JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, audience = `ACCESS_AUD`) on every `/api/*` request, except `/api/health`. In local dev, a `DEV_BYPASS_AUTH=true` var skips this.
- Data model includes **no** `user_id` (explicit decision: single user).

---

## 3. Architecture

### 3.1 Overview

```
                ┌──────────────────────────── Cloudflare Access ────────────────────────────┐
 Browser ──────▶│  Worker "job-scout"  (Hono)                                              │
 (React SPA)    │   • fetch():   /api/*  REST  +  static assets (React build)               │
                │   • scheduled(): hourly cron → "is it a scan time in Europe/London?"     │
                │   • queue():   consumers for  fetch-q · process-q · score-q              │
                └───────┬──────────────┬───────────────┬───────────────┬───────────────────┘
                        │              │               │               │
                    D1 (SQLite)     R2 (CV files)   Vectorize        Workers AI
                    jobs, cvs,                      job + CV         • bge embeddings
                    runs, pipeline                  embeddings       • Llama scoring / notes
                        │                                            • toMarkdown (CV parse)
                        ▼
                 Reed Jobseeker API  (via SourceAdapter interface)
```

**One Worker** with three handlers (`fetch`, `scheduled`, `queue`) keeps deployment simple. The React dashboard is served from the same Worker via **Workers Static Assets** (Cloudflare's current recommendation over Pages; functionally equivalent).

### 3.2 Cloudflare resources

| Resource | Name | Purpose |
|---|---|---|
| Worker | `job-scout` | API, cron, queue consumers, static assets |
| D1 | `job_scout_db` | All relational data |
| R2 bucket | `job-scout-cvs` | Original uploaded CV files (private) |
| Vectorize index | `job-scout-vectors` | 768-dim, cosine. Job embeddings (`ns=job`) and CV embeddings (`ns=cv`) via metadata `kind` |
| Queue | `fetch-q` | One message per (run, search profile, page) |
| Queue | `process-q` | One message per new job: details → normalise → filter → embed → dedupe → prefilter score |
| Queue | `score-q` | One message per job selected for Llama assessment |
| Queue (DLQ) | `job-scout-dlq` | Dead letters from all three queues (max retries 3) |
| Workers AI | binding `AI` | Embeddings, LLM, document → markdown |
| Cron Trigger | `0 * * * *` | Hourly; Worker decides whether to start a run (see §5.1) |
| Secrets | `REED_API_KEY`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` | Via `wrangler secret put` |

### 3.3 Models (configurable in Settings, defaults below)

| Use | Default model | Notes |
|---|---|---|
| Embeddings | `@cf/baai/bge-base-en-v1.5` (768-d) | Fast, cheap. Truncate input to ~500 tokens: title + first part of description + skills |
| Scoring / extraction | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Use JSON-schema `response_format` where supported; always validate with Zod and retry once with a repair prompt |
| Cover notes | same as scoring | On-demand only |
| Cheap fallback | `@cf/meta/llama-3.1-8b-instruct` | Used automatically if daily neuron budget is > 80% spent |
| CV parsing | `env.AI.toMarkdown()` | PDF + DOCX → Markdown. Fallback: `unpdf` for PDF |

**[ASSUMPTION]** Model IDs above are current at time of writing; the implementer should confirm against the Workers AI model catalogue and keep them as config values, not hard-coded strings.

---

## 4. Job source: Reed Jobseeker API

### 4.1 API facts **[ASSUMPTION — verify against https://www.reed.co.uk/developers/jobseeker]**
- Base URL: `https://www.reed.co.uk/api/1.0/`
- Auth: HTTP Basic, **API key as username, empty password**.
- `GET search?keywords=&locationName=&distanceFromLocation=&permanent=&contract=&temp=&partTime=&fullTime=&minimumSalary=&maximumSalary=&postedByRecruitmentAgency=&postedByDirectEmployer=&resultsToTake=100&resultsToSkip=`
  - Returns `{ results: [{ jobId, employerId, employerName, employerProfileId, employerProfileName, jobTitle, locationName, minimumSalary, maximumSalary, currency, expirationDate, date, jobDescription (snippet), applications, jobUrl }], totalResults }`
- `GET jobs/{jobId}` → full details incl. full `jobDescription` (HTML), `salary` (free-text, e.g. "£550 - £650 per day"), `contractType`, `jobType`, `fullTime`, `partTime`, `datePosted`, `externalUrl`, `yearlyMinimumSalary`, `yearlyMaximumSalary`.
- Rate limits are not well documented. Design for a **configurable daily request budget** (default `REED_DAILY_REQUEST_BUDGET=900`) and a per-run cap; back off on HTTP 429/5xx with exponential retry (via queue retry with delay).

### 4.2 Search strategy
- Each **search profile** (see §6) expands to one or more **queries** (`keywords` × `location` × contract/perm flags).
- For each query: page through results (`resultsToTake=100`), **stop paging** when a page contains **zero unseen `jobId`s**, or after `MAX_PAGES_PER_QUERY` (default 3).
- Only fetch `jobs/{id}` details for **unseen** jobIds.
- Record every API call in `source_calls` for budgeting and debugging.

### 4.3 Source adapter interface (for phase 2 extensibility)

```ts
export interface SourceAdapter {
  id: 'reed' | 'adzuna' | 'jooble' | 'rss' | string;
  search(q: SearchQuery, page: number, env: Env): Promise<{ items: RawJobRef[]; hasMore: boolean }>;
  details(ref: RawJobRef, env: Env): Promise<RawJob>;
  normalise(raw: RawJob): NormalisedJob;   // pure, unit-tested
}
```

Only `ReedAdapter` is implemented in phase 1. Everything downstream works on `NormalisedJob` only.

### 4.4 NormalisedJob

```ts
type NormalisedJob = {
  source: string;               // 'reed'
  sourceJobId: string;          // Reed jobId
  url: string;                  // jobUrl
  externalApplyUrl?: string;
  title: string;
  employerName: string;         // often the agency on Reed
  isAgency: boolean | null;     // from query flag or heuristics
  location: string;
  workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';   // heuristic from text, refined by LLM
  employmentType: 'contract' | 'permanent' | 'temp' | 'unknown';
  salaryText?: string;
  payMin?: number; payMax?: number;
  payPeriod: 'day' | 'hour' | 'year' | 'unknown';
  currency: 'GBP';
  ir35?: 'inside' | 'outside' | 'unknown';               // heuristic, refined by LLM
  contractLengthMonths?: number;
  postedAt: string; expiresAt?: string;
  descriptionHtml: string; descriptionText: string;
  applicationsCount?: number;
};
```

**Pay parsing** (pure function, heavily unit-tested): parse `salary` text and min/max fields into `payMin/payMax/payPeriod`. Treat values < 2,000 with no period as **day rate** if contract, values > 10,000 as **annual**. Also compute `annualisedMin/Max` (day × `WORKING_DAYS_PER_YEAR`, default 220) so contract and perm can be compared on one axis.

---

## 5. Pipeline

### 5.1 Scheduling (UK local time)
Cron triggers run in UTC, and the UK shifts between GMT and BST. Therefore:
- Cron `0 * * * *` (hourly).
- `scheduled()` converts `now` to `Europe/London` (via `Intl.DateTimeFormat`) and checks the `schedule` setting, default:
  ```json
  { "mon-fri": ["07:00","12:00","17:00"], "sun": ["17:00"], "sat": [] }
  ```
- If the current local hour matches a slot **and** no run exists for that slot (`runs.slot_key = '2026-11-19T07:00'`, UNIQUE), create a run and enqueue work. Idempotent if cron double-fires.
- Dashboard has a **"Run now"** button (`POST /api/runs`) which creates a run with `trigger='manual'`.

### 5.2 Run stages

```
Stage A  scheduled()/manual
         → insert runs row (status=running)
         → for each active search_profile × query: send fetch-q {runId, profileId, query, page:0}

Stage B  fetch-q consumer
         → Reed search page → upsert job refs (INSERT OR IGNORE on (source, source_job_id))
         → for each NEW ref: send process-q {runId, jobId}
         → if page had new refs && page < MAX_PAGES: send fetch-q page+1
         → record profile↔job link in job_profile_hits (which profile found it)

Stage C  process-q consumer (per job)
         1. fetch details → normalise → save
         2. HARD FILTERS (§7.1) → if fail: status='filtered', reason saved, stop
         3. embed job text → upsert into Vectorize (kind=job)
         4. DEDUPE (§8) → attach to existing job_group or create new group
            → if group already assessed: copy assessment, stop
         5. PREFILTER SCORE: cosine sim vs each active CV embedding → job_cv_similarity rows
            prefilter_score = max sim (normalised 0–100) + small rule bonuses (§7.2)
         6. status='prefiltered'

Stage D  run finaliser (triggered when process-q drains for this run;
         implement as: each process-q message decrements runs.pending_count;
         the message that hits 0 performs selection)
         → select top MAX_LLM_PER_RUN groups by prefilter_score where score ≥ PREFILTER_MIN (default 55)
         → send score-q {runId, groupId}
         → remaining groups: status='below_threshold' (still visible under a "More" filter)

Stage E  score-q consumer
         → Llama assessment (§7.3) → validate → save assessment
         → compute final_score (§7.4) → status='new' (appears in Inbox)
         → when all scored: runs.status='completed', write run summary
```

### 5.3 Run summary
`runs` row stores: started/finished, trigger, counts (fetched, new, filtered, duplicates, prefiltered, llm_scored, inbox_added), Reed calls used, AI neurons estimate, errors. Shown on the **Runs** page.

### 5.4 Failure handling
- Every queue consumer is idempotent (keyed on runId+jobId/groupId) and safe to retry.
- Max 3 retries with backoff, then DLQ. A "Runs" page shows DLQ count and the last 20 errors (`run_errors` table).
- Budget guard: before each Reed call and each LLM call, check today's counters in `usage_daily`; if exhausted, mark remaining work `deferred` and pick it up at the next run.
- A run stuck in `running` > 30 minutes is marked `stale` by the next cron tick.

---

## 6. CVs and search profiles

### 6.1 CVs (exactly up to 4 active; more can be stored but max 4 active)
- Upload PDF or DOCX (≤ 5 MB) via dashboard → stored in R2 at `cvs/{cvId}/{filename}`.
- Text extracted via `env.AI.toMarkdown()` → stored in `cvs.text_md`. User can **edit the extracted text** in the UI (parsing is never perfect).
- On save: generate a **CV summary** with Llama (skills list, seniority, sectors, years of experience, headline) stored as JSON, and an **embedding** of `headline + skills + summary` upserted into Vectorize (`kind=cv`, id `cv:{cvId}`).
- Each CV has a user-given **label** (e.g. "Agile Coach", "Delivery Lead", "Scrum Master", "Programme Manager").

### 6.2 Search profiles (one per CV, editable)
Fields:
| Field | Example | Use |
|---|---|---|
| `cv_id` | | which CV this profile represents |
| `job_titles[]` | "Agile Coach", "Enterprise Agile Coach" | each title becomes a Reed `keywords` query |
| `must_keywords[]` | "SAFe" | optional; added to query or used as a soft boost |
| `exclude_keywords[]` | "graduate", "junior", "SC cleared only" | hard filter |
| `locations[]` | "London", "Manchester", "Remote" | `locationName`; "Remote" → no location, require remote in filter |
| `radius_miles` | 25 | `distanceFromLocation` |
| `employment_types` | contract, permanent | Reed flags + hard filter |
| `min_day_rate` | 500 | hard filter for contract (if rate known) |
| `min_salary` | 70000 | Reed `minimumSalary` + hard filter for perm |
| `ir35_preference` | `outside_only` \| `prefer_outside` \| `any` | hard filter or boost |
| `work_mode` | remote, hybrid, onsite (multi) | filter/boost |
| `max_onsite_days` | 2 | soft penalty if LLM extracts more |
| `active` | true | |

On first CV upload, **pre-fill** the profile from the CV summary (suggested titles/keywords) for the user to confirm.

---

## 7. Scoring

### 7.1 Hard filters (Stage C2, deterministic, no AI)
A job is `filtered` (kept in DB with reason, hidden by default) if **for every** profile that found it:
- employment type not in profile's types; or
- contains any `exclude_keywords` (title or description, case-insensitive, word-boundary); or
- pay is known and below `min_day_rate` / `min_salary`; or
- `ir35_preference=outside_only` and IR35 is detectably "inside"; or
- profile requires remote and text clearly says on-site full-time; or
- employer/agency is on the global **blocklist** (Settings).

Unknown values (no pay stated, IR35 unknown) **pass** the filter.

### 7.2 Prefilter score (0–100)
```
sim        = max over active CVs of cosine(job_vec, cv_vec)
sim_norm   = clamp((sim - 0.55) / (0.85 - 0.55), 0, 1) * 100     // calibrate bounds during build
bonus      = +5 if title matches a profile job_title (fuzzy)
           + 3 if pay disclosed
           + 3 if ir35 outside (contract) 
           + feedback_adj (§10, range −10..+10)
prefilter  = clamp(sim_norm + bonus, 0, 100)
```
Store `best_cv_id_by_sim` and all four similarities.

### 7.3 Llama assessment (Stage E)
**Input:** normalised job (title, employer, location, pay text, description text truncated to ~3,500 tokens) + the **CV summaries of all active CVs** + full text of the **top-2 CVs by similarity** (truncated) + the relevant profile preferences.

**System prompt (outline):**
> You are an expert UK recruitment consultant assessing fit between a job advert and a candidate's CVs. Be strict and evidence-based; only cite skills present in the CV text. UK conventions: day rates, IR35, SC/DV clearance, hybrid days. Return ONLY JSON matching the schema.

**Output schema (validated with Zod):**
```json
{
  "fit_score": 0-100,
  "best_cv_id": "string",
  "cv_scores": [{ "cv_id": "string", "score": 0-100 }],
  "headline": "one-line why this fits (≤140 chars)",
  "strengths": ["≤5 bullets with evidence"],
  "gaps": ["≤5 bullets: missing requirements"],
  "red_flags": ["e.g. 'inside IR35', '5 days onsite', 'rate not stated', 'clearance required'"],
  "seniority_match": "under|match|over",
  "extracted": {
    "employment_type": "contract|permanent|temp|unknown",
    "pay_min": number|null, "pay_max": number|null,
    "pay_period": "day|hour|year|unknown",
    "ir35": "inside|outside|unknown",
    "contract_length_months": number|null,
    "start": "string|null",
    "work_mode": "remote|hybrid|onsite|unknown",
    "onsite_days_per_week": number|null,
    "location": "string|null",
    "clearance": "none|BPSS|SC|DV|unknown",
    "hiring_company": "end client if named, else null",
    "agency": "recruitment agency if applicable, else null",
    "contact_name": "string|null",
    "contact_email": "string|null",
    "contact_phone": "string|null",
    "reference": "job ref if present|null",
    "closing_date": "string|null"
  },
  "apply_recommendation": "strong_apply|apply|maybe|skip",
  "confidence": 0-1
}
```
**Rules:**
- Extracted contact details must come **only from the advert text**; never invented. Post-validate: any `contact_email` must appear verbatim in the description, else null it.
- If JSON is invalid: one repair retry ("Your last output was invalid: <zod errors>. Return corrected JSON only."), then fall back to the 8B model, then mark `assessment_failed` (job still shown with prefilter score).
- Prefer extracted values over regex-parsed ones only when the regex value was `unknown`.

### 7.4 Final score & ranking
```
final_score = round(0.75 * fit_score + 0.20 * prefilter_sim_norm + 0.05 * freshness)
              + feedback_adj
freshness   = 100 if posted < 24h, 70 if < 72h, 40 if < 7d, else 10
```
Inbox default sort: `final_score desc`, tie-break `posted_at desc`. Weights live in Settings.

Badges: **Strong** ≥ 80, **Good** 65–79, **Maybe** 50–64.

---

## 8. De-duplication

1. **Exact:** `UNIQUE(source, source_job_id)` — skipped at insert.
2. **Near-duplicate** (different agencies / reposts), checked in Stage C4:
   - Query Vectorize for top 5 nearest `kind=job` vectors posted within the last **21 days**.
   - Candidate is a duplicate if `cosine ≥ DEDUPE_SIM` (default **0.92**) **and** at least one of:
     - normalised titles match (lowercase, strip seniority noise/punctuation, token-set ratio ≥ 0.8), or
     - same pay band (±10%) and same location/city.
   - Duplicate → join the existing `job_group`; a group holds 1..n `jobs` (postings).
3. Assessment happens **per group**, once. New postings joining an already-assessed group inherit its assessment and don't consume LLM budget.
4. The card shows "**Also posted by:** Agency A, Agency B (+2)" with each posting's link and pay, highlighting the **highest stated rate**.
5. If a group was already **Skipped** or **Applied**, new postings join silently and don't resurface in the Inbox (but show a "new posting" count on the card in Pipeline).

---

## 9. Dashboard (React + Vite + Tailwind, served by the Worker)

Design goal: **fast triage**. Keyboard shortcuts in Inbox: `j/k` move, `a` shortlist, `x` skip (with a quick reason), `o` open advert, `c` generate cover note.

### 9.1 Pages
1. **Inbox** (default) — new, unactioned groups from the last 7 days, ranked.
   - Filters: contract/perm, CV, min score, work mode, IR35, posted since, "show below threshold", "show filtered".
   - Card: score badge, title, hiring company / agency, location + work mode, pay (normalised "£600/day" or "£85k"), IR35, contract length, posted age, best CV label, headline, top 3 strengths, top 2 gaps, red flags, "also posted by", buttons: Shortlist · Skip · Open advert · Cover note.
2. **Job detail** (drawer or page) — full assessment, all extracted fields, contact details, per-CV scores, all postings, full description, cover-note panel, notes, status history.
3. **Pipeline** — columns/list by status: Shortlisted → Applied → Interview → Offer / Rejected; Skipped hidden by default. Fields: date applied, CV sent, notes.
4. **CVs & Profiles** — upload/replace CV, edit extracted text, view CV summary, edit search profile, toggle active.
5. **Settings** — schedule, scoring weights and thresholds, budgets (`MAX_LLM_PER_RUN`, Reed daily budget), models, global blocklist (employers/agencies/keywords), working days per year, dedupe threshold.
6. **Runs** — last 30 runs with counts, duration, budget used, errors, "Run now" button.

### 9.2 Cover note (on demand)
- `POST /api/groups/:id/cover-note { cvId?, tone: 'concise'|'warm'|'formal', kind: 'cover_note'|'recruiter_message' }`
- Llama drafts ≤ 200 words (cover note) or ≤ 90 words (LinkedIn/email recruiter message), using **only** facts from the chosen CV and the advert; mirrors key advert terms; no clichés; UK spelling.
- Saved to `cover_notes`, editable, copy-to-clipboard. Regenerate keeps history.

---

## 10. Pipeline statuses & feedback learning

### 10.1 Statuses
`new → shortlisted → applied → interview → offer | rejected`, plus `skipped` (from any state) and `withdrawn`. Every change is written to `status_history`.

On **Applied**: require `cv_id_sent`, default `applied_at = now`.
On **Skip**: optional quick reason chip: `rate_too_low`, `location`, `not_my_skills`, `too_junior`, `too_senior`, `inside_ir35`, `agency_spam`, `already_applied_elsewhere`, `other`.

### 10.2 Feedback adjustments (simple, transparent, phase 1)
Compute `feedback_adj` (−10..+10) per new group at prefilter time:
- **Employer/agency:** ≥ 3 skips with `agency_spam` from same agency → −10; any previous Apply with same hiring company → +5.
- **Similarity to applied jobs:** max cosine to the last 50 applied/shortlisted job vectors ≥ 0.88 → +5.
- **Similarity to skipped (not_my_skills) jobs:** max cosine to last 50 such skips ≥ 0.90 → −5.
- Skip reasons `rate_too_low` / `location` / `inside_ir35` **don't** adjust silently; instead the Settings page shows a suggestion ("You've skipped 6 jobs under £550/day — raise min day rate?") with one-click apply.

All adjustments are shown on the job detail page ("−5: similar to jobs you skipped as not your skills").

---

## 11. Data model (D1 / SQLite)

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE cvs (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, r2_key TEXT NOT NULL, filename TEXT,
  text_md TEXT NOT NULL, summary_json TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE search_profiles (
  id TEXT PRIMARY KEY, cv_id TEXT NOT NULL REFERENCES cvs(id),
  job_titles_json TEXT NOT NULL, must_keywords_json TEXT, exclude_keywords_json TEXT,
  locations_json TEXT NOT NULL, radius_miles INTEGER DEFAULT 25,
  employment_types_json TEXT NOT NULL, min_day_rate INTEGER, min_salary INTEGER,
  ir35_preference TEXT DEFAULT 'any', work_modes_json TEXT, max_onsite_days INTEGER,
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, slot_key TEXT UNIQUE, trigger TEXT NOT NULL,      -- 'cron'|'manual'
  status TEXT NOT NULL,                                                  -- running|completed|failed|stale
  pending_count INTEGER NOT NULL DEFAULT 0, counts_json TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE run_errors (id INTEGER PRIMARY KEY, run_id TEXT, stage TEXT, ref TEXT, message TEXT, created_at TEXT);
CREATE TABLE source_calls (id INTEGER PRIMARY KEY, run_id TEXT, source TEXT, endpoint TEXT, status INTEGER, ms INTEGER, created_at TEXT);
CREATE TABLE usage_daily (day TEXT PRIMARY KEY, reed_calls INTEGER DEFAULT 0, llm_calls INTEGER DEFAULT 0, embed_calls INTEGER DEFAULT 0, neurons_est INTEGER DEFAULT 0);

CREATE TABLE job_groups (
  id TEXT PRIMARY KEY, canonical_job_id TEXT, status TEXT NOT NULL,      -- filtered|below_threshold|pending_llm|new|shortlisted|applied|interview|offer|rejected|skipped|withdrawn
  prefilter_score REAL, final_score REAL, feedback_adj REAL DEFAULT 0, feedback_reasons_json TEXT,
  best_cv_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, run_id TEXT
);
CREATE INDEX idx_groups_status_score ON job_groups(status, final_score DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, group_id TEXT REFERENCES job_groups(id),
  source TEXT NOT NULL, source_job_id TEXT NOT NULL, url TEXT, external_apply_url TEXT,
  title TEXT, employer_name TEXT, is_agency INTEGER, location TEXT, work_mode TEXT,
  employment_type TEXT, salary_text TEXT, pay_min REAL, pay_max REAL, pay_period TEXT,
  annualised_min REAL, annualised_max REAL, ir35 TEXT, contract_length_months REAL,
  posted_at TEXT, expires_at TEXT, description_text TEXT, description_html TEXT,
  applications_count INTEGER, filter_reason TEXT, raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_job_id)
);
CREATE TABLE job_profile_hits (job_id TEXT, profile_id TEXT, run_id TEXT, PRIMARY KEY(job_id, profile_id));
CREATE TABLE job_cv_similarity (group_id TEXT, cv_id TEXT, similarity REAL, PRIMARY KEY(group_id, cv_id));

CREATE TABLE assessments (
  group_id TEXT PRIMARY KEY, model TEXT, fit_score REAL, best_cv_id TEXT,
  result_json TEXT NOT NULL, status TEXT NOT NULL,                       -- ok|failed
  prompt_version TEXT, created_at TEXT NOT NULL
);

CREATE TABLE applications (
  group_id TEXT PRIMARY KEY, cv_id_sent TEXT, applied_at TEXT, notes TEXT,
  skip_reason TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE status_history (id INTEGER PRIMARY KEY, group_id TEXT, from_status TEXT, to_status TEXT, at TEXT);
CREATE TABLE cover_notes (id TEXT PRIMARY KEY, group_id TEXT, cv_id TEXT, kind TEXT, tone TEXT, text TEXT, created_at TEXT);
```

Retention: delete `filtered` / `below_threshold` groups (and their vectors) older than 30 days; keep anything actioned forever. Run a cleanup in the 17:00 run.

---

## 12. API (Hono, all under `/api`, JSON)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Unauthenticated liveness |
| GET | `/groups?status=&cv=&minScore=&type=&workMode=&ir35=&since=&limit=&cursor=` | Inbox / Pipeline lists |
| GET | `/groups/:id` | Full detail: postings, assessment, similarities, feedback reasons, history, notes |
| PATCH | `/groups/:id` | `{status, cvIdSent?, notes?, skipReason?}` |
| POST | `/groups/:id/rescore` | Force re-assessment (counts against budget) |
| POST | `/groups/:id/cover-note` | Generate note |
| GET | `/cvs` · POST `/cvs` (multipart) · PATCH `/cvs/:id` · DELETE `/cvs/:id` | CV management (re-embed + re-summarise on text change) |
| GET/PUT | `/profiles/:id` | Search profile |
| GET/PUT | `/settings` | All settings |
| GET | `/runs` · GET `/runs/:id` · POST `/runs` | Runs list/detail, manual run |
| GET | `/stats` | Counts for header: new today, shortlisted, applied this week, budget used |

Validation with Zod on every request body; shared types between Worker and SPA via a `packages/shared` workspace.

---

## 13. Repository layout (new repo, e.g. `job-scout`)

```
job-scout/
├─ apps/
│  ├─ worker/
│  │  ├─ src/
│  │  │  ├─ index.ts            # export default { fetch, scheduled, queue }
│  │  │  ├─ api/                # Hono routes
│  │  │  ├─ auth/access.ts      # CF Access JWT verify
│  │  │  ├─ sources/reed.ts     # ReedAdapter
│  │  │  ├─ sources/types.ts
│  │  │  ├─ pipeline/{schedule,fetch,process,select,score,finalise}.ts
│  │  │  ├─ scoring/{filters,prefilter,final,feedback}.ts
│  │  │  ├─ dedupe/
│  │  │  ├─ ai/{embed,llm,prompts,schemas}.ts
│  │  │  ├─ parse/{pay,ir35,workmode}.ts
│  │  │  └─ db/                 # typed queries (drizzle-orm d1 or kysely)
│  │  ├─ migrations/            # D1 SQL migrations
│  │  ├─ test/                  # vitest + @cloudflare/vitest-pool-workers, Reed fixtures
│  │  └─ wrangler.jsonc
│  └─ web/                      # React + Vite + Tailwind + TanStack Query
├─ packages/shared/             # Zod schemas + TS types
├─ docs/SPEC.md                 # this file
└─ package.json                 # pnpm workspaces
```

### 13.1 `wrangler.jsonc` essentials
```jsonc
{
  "name": "job-scout",
  "main": "apps/worker/src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "apps/web/dist", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] },
  "triggers": { "crons": ["0 * * * *"] },
  "d1_databases": [{ "binding": "DB", "database_name": "job_scout_db", "database_id": "<fill>" }],
  "r2_buckets": [{ "binding": "CVS", "bucket_name": "job-scout-cvs" }],
  "vectorize": [{ "binding": "VEC", "index_name": "job-scout-vectors" }],
  "ai": { "binding": "AI" },
  "queues": {
    "producers": [
      { "binding": "FETCH_Q", "queue": "fetch-q" },
      { "binding": "PROCESS_Q", "queue": "process-q" },
      { "binding": "SCORE_Q", "queue": "score-q" }
    ],
    "consumers": [
      { "queue": "fetch-q",   "max_batch_size": 5,  "max_retries": 3, "dead_letter_queue": "job-scout-dlq" },
      { "queue": "process-q", "max_batch_size": 10, "max_retries": 3, "dead_letter_queue": "job-scout-dlq" },
      { "queue": "score-q",   "max_batch_size": 3,  "max_concurrency": 2, "max_retries": 3, "dead_letter_queue": "job-scout-dlq" }
    ]
  },
  "vars": { "TZ_NAME": "Europe/London", "DEV_BYPASS_AUTH": "false" }
}
```
Vectorize index: `wrangler vectorize create job-scout-vectors --dimensions=768 --metric=cosine`, plus metadata indexes on `kind` (string) and `posted_ts` (number).

---

## 14. Non-functional requirements

- **Cost:** target within Workers Paid plan ($5/month) + Workers AI usage. Per run: ≤ ~60 Reed calls, ≤ 30 LLM assessments, a few hundred embeddings. Settings page shows today's estimated neurons vs `AI_DAILY_NEURON_BUDGET`.
- **Performance:** dashboard Inbox API p95 < 300 ms; run end-to-end < 10 minutes.
- **Security & privacy:** CVs contain personal data — R2 bucket private, never public URLs; CV text only sent to Workers AI (stays in Cloudflare); secrets via Wrangler secrets; no third-party analytics. Provide "Delete all data" in Settings.
- **Observability:** structured `console.log` JSON with `runId`, `stage`, `jobId`; Workers Logs enabled; Runs page as the human view.
- **Prompt versioning:** `PROMPT_VERSION` constant stored with each assessment, so rescoring after prompt changes is traceable.
- **Respect sources:** honour Reed terms of use, include attribution/link back to the Reed advert, never republish adverts publicly.

---

## 15. Testing & acceptance

**Unit (vitest):** pay parser (≥ 30 real-world UK salary strings: "£550 - £650 per day", "Up to £85k + bonus", "£45 per hour", "Competitive"), IR35 detection, work-mode detection, title normalisation, hard filters, prefilter/final score maths, schedule slot detection across the March/October clock changes, Zod schema validation of LLM output including malformed samples.

**Integration (`@cloudflare/vitest-pool-workers`, Miniflare):** run pipeline end-to-end with recorded Reed fixtures and a mocked `AI` binding returning canned embeddings/JSON; assert counts, dedupe grouping, idempotent re-run of the same slot, budget exhaustion → `deferred`.

**Acceptance (manual, on deployed env):**
1. Upload 4 CVs; profiles pre-filled; edit and save.
2. Press "Run now"; Runs page shows progress and completion.
3. Inbox shows ranked cards with pay, IR35, best CV, reasons.
4. Shortlist → Apply with CV sent; appears correctly in Pipeline.
5. Generate a cover note and a recruiter message.
6. Next scheduled run fires at the right UK time and only adds new jobs.

---

## 16. Build plan (suggested order for Claude Code)

1. **Scaffold:** pnpm monorepo, Worker + Hono, React app, shared package, wrangler config, D1 migrations, local dev with `wrangler dev` and `DEV_BYPASS_AUTH`.
2. **Reed adapter + normaliser + pay/IR35/work-mode parsers** with fixtures and unit tests.
3. **CV upload → toMarkdown → summary → embedding**; CVs & Profiles UI.
4. **Pipeline stages A–C** with queues; hard filters; embeddings; dedupe; prefilter score; Runs page.
5. **Stage D–E**: selection + Llama assessment + final score.
6. **Inbox + Job detail + Pipeline UI** with keyboard shortcuts.
7. **Cover notes.**
8. **Feedback adjustments + settings suggestions.**
9. **Scheduling with UK local time, budgets, retention cleanup, Access JWT verification.**
10. **Deploy** (`wrangler deploy`), configure Access, README with setup steps (create D1/R2/Vectorize/queues, set secrets, run migrations).

---

## 17. Phase 2 backlog (out of scope now)
- More sources via `SourceAdapter`: **Adzuna**, **Jooble**, **Careerjet**, **RSS** (jobs.ac.uk, Civil Service Jobs, Guardian Jobs), optional job-alert email ingestion via Cloudflare Email Routing.
- Email digest / Telegram alert for scores ≥ 85.
- CV tweak suggestions per job; per-job tailored CV export.
- Lightweight CRM: contacts, follow-up reminders, interview calendar.
- Learned ranking model from accumulated feedback.
- Market insights: day-rate trends per title, most-active agencies.

---

## 18. Open assumptions to verify during build
1. Reed API endpoint shapes, field names and rate limits (§4.1).
2. Workers AI model IDs, JSON-schema support and neuron pricing (§3.3).
3. `env.AI.toMarkdown()` quality on the user's actual CV files (fallback: `unpdf` / `mammoth`).
4. Similarity calibration bounds (0.55 / 0.85) and dedupe threshold (0.92) — tune with real data after the first few runs; expose in Settings.
5. Reed adverts rarely include direct contact emails — expect `contact_*` fields to be mostly the agency name; that's acceptable for phase 1.

# Job Scout — Technical Implementation Plan

> **Companion to `SPEC.md`.** The spec says *what* to build; this plan says *how*, in *what order*, and *what "done" means at every step*.
> **Claude Code: follow this plan milestone by milestone. Do not start a milestone until the previous one's exit criteria pass. If the plan and the spec disagree, the spec wins on behaviour and this plan wins on structure — note the conflict in `docs/DECISIONS.md`.**

---

## Part 1 — Engineering ground rules

### 1.1 Principles
1. **Vertical slices, always green.** Every milestone ends with `pnpm check` passing (typecheck + lint + tests + build) and something runnable.
2. **Pure core, thin edges.** Parsing, filtering, scoring, dedupe decisions and schedule logic are **pure functions** with no Cloudflare imports. Bindings (D1, R2, Vectorize, AI, Queues, Reed HTTP) live behind small interfaces ("ports") so the core is testable with fakes.
3. **Types flow from one place.** Zod schemas in `packages/shared` → inferred TS types → used by Worker validation, LLM output validation, and the React client.
4. **Idempotent by construction.** Every queue handler can run twice with the same message and produce the same state.
5. **Config, not constants.** Thresholds, weights, model IDs, budgets and schedule live in the `settings` table with typed defaults in code.
6. **No silent failure.** Every caught error is either retried (queue) or written to `run_errors` with stage + ref.
7. **Small commits, conventional messages** (`feat(pipeline): …`, `fix(parse): …`, `test(dedupe): …`).

### 1.2 Tooling decisions (fixed)

| Concern | Choice | Why |
|---|---|---|
| Package manager | **pnpm** workspaces | Fast, strict, good monorepo support |
| Language | **TypeScript**, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` | Catch bugs at compile time |
| Lint + format | **Biome** | One fast tool, zero config drift |
| Worker framework | **Hono** + `@hono/zod-validator` | Small, typed, Workers-native; Hono RPC gives a typed client |
| ORM / SQL | **Drizzle ORM** (`drizzle-orm/d1`) + **drizzle-kit** for migrations | Typed queries, SQL-first, D1 support |
| Validation | **Zod** | Shared request/LLM schemas |
| Worker tests | **Vitest** + **`@cloudflare/vitest-pool-workers`** | Runs tests inside workerd with real D1/Queues/R2 emulation |
| Dev server | **Vite** + **`@cloudflare/vite-plugin`** | One `pnpm dev` runs Worker + SPA with HMR |
| Frontend | **React 19**, **React Router** (library mode), **TanStack Query**, **Tailwind CSS v4**, **shadcn/ui-style** primitives (copied in, not a dependency) | Fast to build a slick, accessible UI |
| Env typing | `wrangler types` → `worker-configuration.d.ts` | Bindings always match config |
| CI | **GitHub Actions** | check on every push; deploy on `main` |
| IDs | `crypto.randomUUID()`; ULID-style sortable IDs for `runs` (`ulid` pkg) | Sortable run history |
| Dates | ISO-8601 UTC strings in DB; `Intl.DateTimeFormat` for Europe/London | No date library needed |

Pin exact versions in `package.json` (no `^`) at scaffold time; Renovate/Dependabot is phase 2.

### 1.3 Commands (must exist from M0)

| Command | Does |
|---|---|
| `pnpm dev` | Vite dev server: SPA + Worker (local D1/R2/Queues; AI + Vectorize as remote bindings) |
| `pnpm check` | `typecheck && lint && test && build` — the gate for every milestone |
| `pnpm test` / `pnpm test:watch` | All Vitest projects |
| `pnpm db:generate` | drizzle-kit → new SQL migration in `apps/worker/migrations` |
| `pnpm db:migrate:local` / `db:migrate:remote` | `wrangler d1 migrations apply job_scout_db --local/--remote` |
| `pnpm cf:types` | `wrangler types` |
| `pnpm seed:local` | Load fixture CVs + settings into local D1 |
| `pnpm run:local` | Trigger a manual run against local dev (`POST /api/runs`) |
| `pnpm deploy` | Build SPA → `wrangler deploy` |

---

## Part 2 — Architecture in code

### 2.1 Repository layout

```
job-scout/
├─ CLAUDE.md                         # agent instructions (Part 5)
├─ docs/
│  ├─ SPEC.md
│  ├─ IMPLEMENTATION_PLAN.md
│  ├─ DECISIONS.md                   # ADR-lite log, one entry per deviation/choice
│  └─ RUNBOOK.md                     # setup, deploy, rotate keys, debug a run
├─ apps/
│  ├─ worker/
│  │  ├─ src/
│  │  │  ├─ index.ts                 # { fetch, scheduled, queue } — wiring only
│  │  │  ├─ container.ts             # builds ports from env (DI root)
│  │  │  ├─ config/
│  │  │  │  ├─ defaults.ts           # typed default settings
│  │  │  │  └─ settings.ts           # load/merge/save settings
│  │  │  ├─ http/
│  │  │  │  ├─ app.ts                # Hono app, middleware, error handler
│  │  │  │  ├─ middleware/{auth,requestId,errors}.ts
│  │  │  │  └─ routes/{groups,cvs,profiles,settings,runs,stats,health}.ts
│  │  │  ├─ ports/                   # interfaces only
│  │  │  │  ├─ source.ts  vector.ts  llm.ts  embed.ts  blob.ts  queue.ts  clock.ts  docparse.ts
│  │  │  ├─ adapters/                # real implementations of ports
│  │  │  │  ├─ reed/{client.ts,adapter.ts,types.ts}
│  │  │  │  ├─ workersai/{llm.ts,embed.ts,toMarkdown.ts}
│  │  │  │  ├─ vectorize.ts  r2.ts  queues.ts  clock.ts
│  │  │  ├─ core/                    # PURE logic — no env, no fetch
│  │  │  │  ├─ parse/{pay.ts,ir35.ts,workMode.ts,employmentType.ts,text.ts,title.ts}
│  │  │  │  ├─ normalise.ts
│  │  │  │  ├─ filters.ts
│  │  │  │  ├─ scoring/{prefilter.ts,final.ts,feedback.ts,badges.ts}
│  │  │  │  ├─ dedupe.ts
│  │  │  │  ├─ schedule.ts
│  │  │  │  └─ budget.ts
│  │  │  ├─ pipeline/                # orchestration — uses ports + core
│  │  │  │  ├─ startRun.ts  fetchPage.ts  processJob.ts  selectForScoring.ts
│  │  │  │  ├─ assessGroup.ts  finaliseRun.ts  cleanup.ts  messages.ts
│  │  │  ├─ ai/
│  │  │  │  ├─ prompts/{assess.ts,cvSummary.ts,coverNote.ts}   # versioned
│  │  │  │  └─ structured.ts         # call → zod validate → repair → fallback
│  │  │  ├─ db/
│  │  │  │  ├─ schema.ts             # Drizzle schema (single source of truth)
│  │  │  │  ├─ client.ts
│  │  │  │  └─ repos/{runs,jobs,groups,cvs,profiles,assessments,applications,usage,settings}.ts
│  │  │  └─ lib/{log.ts,errors.ts,ids.ts,result.ts,time.ts}
│  │  ├─ migrations/                 # generated SQL, committed
│  │  ├─ test/
│  │  │  ├─ fixtures/{reed/*.json,cvs/*.md,llm/*.json,salaries.json}
│  │  │  ├─ fakes/{fakeSource,fakeVector,fakeLlm,fakeEmbed,fakeClock}.ts
│  │  │  ├─ unit/…  integration/…
│  │  ├─ vitest.config.ts
│  │  └─ wrangler.jsonc
│  └─ web/
│     ├─ src/
│     │  ├─ main.tsx  router.tsx
│     │  ├─ api/{client.ts,queries.ts}      # Hono RPC client + TanStack Query hooks
│     │  ├─ components/ui/…                 # Button, Badge, Card, Dialog, Drawer, Toast, Tabs, Input, Select, Kbd
│     │  ├─ components/{JobCard,ScoreBadge,PayChip,FilterBar,StatusMenu,SkipReasonPicker,CoverNotePanel,RunTable}.tsx
│     │  ├─ features/{inbox,job,pipeline,cvs,settings,runs}/…
│     │  ├─ hooks/{useHotkeys.ts,useFilters.ts}
│     │  └─ styles.css
│     ├─ index.html  vite.config.ts
├─ packages/
│  └─ shared/src/{schemas/*.ts,types.ts,constants.ts,index.ts}
├─ .github/workflows/{ci.yml,deploy.yml}
├─ biome.json  tsconfig.base.json  pnpm-workspace.yaml  package.json
```

**Dependency rule (enforced by lint `noRestrictedImports` / review):**
`core/` imports only `packages/shared` and `lib/`. `pipeline/` imports `core/`, `ports/`, `db/repos/`. `adapters/` implement `ports/`. `http/` calls `pipeline/` and `db/repos/`. Nothing imports `adapters/` except `container.ts`.

### 2.2 Ports (interfaces)

```ts
// ports/source.ts
export interface SourceAdapter {
  readonly id: string;
  search(q: SearchQuery, page: number): Promise<{ refs: RawJobRef[]; total: number }>;
  details(sourceJobId: string): Promise<RawJob>;
  normalise(raw: RawJob, ctx: { profileEmploymentTypes: EmploymentType[] }): NormalisedJob;
}

// ports/vector.ts
export interface VectorStore {
  upsert(items: { id: string; values: number[]; metadata: VectorMeta }[]): Promise<void>;
  query(values: number[], opts: { topK: number; filter?: Partial<VectorMeta> & { postedTsGte?: number } }): Promise<{ id: string; score: number; metadata: VectorMeta }[]>;
  getByIds(ids: string[]): Promise<{ id: string; values: number[] }[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

// ports/embed.ts
export interface Embedder { embed(texts: string[]): Promise<number[][]>; readonly dims: number; readonly model: string }

// ports/llm.ts
export interface LlmClient {
  complete(req: { model: string; system: string; user: string; maxTokens: number; temperature?: number; jsonSchema?: object }): Promise<{ text: string; usage?: { in: number; out: number } }>;
}

// ports/clock.ts
export interface Clock { now(): Date }

// ports/queue.ts
export interface Bus { send<M extends PipelineMessage>(msg: M, opts?: { delaySeconds?: number }): Promise<void>; sendBatch(msgs: PipelineMessage[]): Promise<void> }

// ports/docparse.ts
export interface DocParser { toMarkdown(file: { name: string; bytes: ArrayBuffer; mime: string }): Promise<string> }

// ports/blob.ts
export interface BlobStore { put(key: string, body: ArrayBuffer, mime: string): Promise<void>; get(key: string): Promise<ArrayBuffer | null>; delete(key: string): Promise<void> }
```

`container.ts`:
```ts
export function createContainer(env: Env, overrides: Partial<Deps> = {}): Deps {
  const db = createDb(env.DB);
  return {
    db, repos: createRepos(db),
    clock: overrides.clock ?? systemClock,
    source: overrides.source ?? new ReedAdapter(new ReedClient(env.REED_API_KEY)),
    vectors: overrides.vectors ?? new VectorizeStore(env.VEC),
    embedder: overrides.embedder ?? new WorkersAiEmbedder(env.AI),
    llm: overrides.llm ?? new WorkersAiLlm(env.AI),
    docs: overrides.docs ?? new WorkersAiDocParser(env.AI),
    blobs: overrides.blobs ?? new R2Blobs(env.CVS),
    bus: overrides.bus ?? new QueueBus({ fetch: env.FETCH_Q, process: env.PROCESS_Q, score: env.SCORE_Q }),
    log: createLogger(),
    ...overrides,
  };
}
```

### 2.3 Queue messages (discriminated union, in `pipeline/messages.ts`)

```ts
export type PipelineMessage =
  | { v: 1; type: 'fetch';   runId: string; profileId: string; queryKey: string; query: SearchQuery; page: number }
  | { v: 1; type: 'process'; runId: string; jobId: string; profileId: string }
  | { v: 1; type: 'score';   runId: string; groupId: string };
```
Each queue consumer: parse with Zod → dispatch → `msg.ack()` on success; on retryable error `msg.retry({ delaySeconds: backoff(attempts) })`; on non-retryable error log to `run_errors` and `ack()`.
`backoff(n) = min(300, 10 * 2^n) + jitter`.

### 2.4 Run accounting (how we know a run is finished)

Use two atomic counters on `runs`: `pending_ingest` (fetch + process messages outstanding) and `pending_score`.

- **Before** enqueueing N messages: `UPDATE runs SET pending_ingest = pending_ingest + N WHERE id = ?`.
- **After** a message's work commits (success *or* terminal failure): `UPDATE runs SET pending_ingest = pending_ingest - 1 WHERE id = ? RETURNING pending_ingest`.
- The handler that observes `0` calls `selectForScoring(runId)`, guarded by `UPDATE runs SET phase='scoring' WHERE id=? AND phase='ingest'` (only one wins).
- Same pattern for `pending_score` → `finaliseRun`.
- Idempotency: each (runId, message-key) is recorded in `processed_messages(key PRIMARY KEY)` via `INSERT OR IGNORE`; if it already exists, skip work **and skip decrement**.
- Safety net: the hourly cron marks runs `stale` if `phase != 'done'` and `started_at < now - 30 min`, and runs `selectForScoring`/`finaliseRun` for them if counters are stuck.

### 2.5 Structured LLM calls (`ai/structured.ts`)

```ts
export async function structured<T>(deps, opts: {
  schema: z.ZodType<T>; prompt: { system: string; user: string; version: string };
  model: string; fallbackModel: string; maxTokens: number; purpose: 'assess'|'cv_summary'|'cover_note';
}): Promise<{ ok: true; data: T; model: string } | { ok: false; error: string }>
```
Flow: budget check → call with JSON schema → strip code fences → `JSON.parse` → `schema.safeParse` → on failure one **repair** call including Zod issues → on failure one call with **fallback model** → else `{ ok:false }`. Every call increments `usage_daily` (llm_calls, neurons_est from token counts × model rate table in `config/defaults.ts`).

### 2.6 Logging
`log.info({ runId, stage, jobId, msg, ...extra })` → `console.log(JSON.stringify(...))`. Request middleware adds `requestId`. Enable Workers Logs (`"observability": { "enabled": true }` in wrangler).

### 2.7 Error model
`lib/errors.ts`: `AppError(code, message, { retryable, status, cause })`. Codes: `VALIDATION`, `NOT_FOUND`, `UNAUTHORIZED`, `UPSTREAM_RATE_LIMIT`, `UPSTREAM_ERROR`, `BUDGET_EXHAUSTED`, `LLM_INVALID_OUTPUT`, `INTERNAL`. Hono `onError` maps to `{ error: { code, message, requestId } }` JSON.

---

## Part 3 — Milestones

Each milestone lists **Tasks → Files → Tests → Exit criteria**. Commit after each task; open/merge one PR per milestone (or push to a milestone branch).

---

### M0 — Scaffold & guardrails (½ day)

**Tasks**
1. `pnpm init`, workspace with `apps/worker`, `apps/web`, `packages/shared`.
2. `tsconfig.base.json` (strict flags above, `moduleResolution: "Bundler"`, `target: ES2022`), per-package tsconfigs with project references.
3. Biome config; `pnpm lint` / `pnpm format`.
4. Worker: Hono app with `GET /api/health` → `{ ok: true, version, time }`. `index.ts` exports `fetch`, stub `scheduled`, stub `queue`.
5. `wrangler.jsonc` per SPEC §13.1 plus `"observability": { "enabled": true }`; AI and Vectorize bindings flagged `"remote": true` for dev. Placeholder IDs documented in RUNBOOK.
6. Web: Vite + React + Tailwind v4 + `@cloudflare/vite-plugin`; a shell layout (sidebar: Inbox, Pipeline, CVs, Settings, Runs; header with stats placeholder; light/dark theme).
7. Vitest workspace: `worker-unit` (node env, for `core/`), `worker-integration` (`@cloudflare/vitest-pool-workers`), `web` (jsdom + Testing Library).
8. `CLAUDE.md`, `docs/DECISIONS.md`, `docs/RUNBOOK.md` skeletons.
9. GitHub Actions `ci.yml`: pnpm install (cached) → `pnpm check`.

**Exit criteria**
- `pnpm dev` serves the SPA shell at `localhost:5173` and `/api/health` returns JSON.
- `pnpm check` green locally and in CI.
- A trivial test exists in each Vitest project.

---

### M1 — Shared schemas, DB schema & settings (½–1 day)

**Tasks**
1. `packages/shared/src/schemas/`: `enums.ts` (EmploymentType, WorkMode, Ir35, PayPeriod, GroupStatus, SkipReason, Clearance, ApplyRecommendation), `job.ts` (NormalisedJob), `assessment.ts` (LLM output schema from SPEC §7.3), `profile.ts`, `cv.ts`, `settings.ts`, `api.ts` (request/response DTOs).
2. `db/schema.ts` in Drizzle mirroring SPEC §11, **plus**: `runs.phase` (`ingest|scoring|done`), `runs.pending_ingest`, `runs.pending_score`, `processed_messages(key TEXT PK, created_at)`, `vector_ids` column on `jobs` if needed.
3. Indexes: `jobs(group_id)`, `jobs(posted_at)`, `job_groups(status, final_score DESC)`, `job_groups(first_seen_at)`, `status_history(group_id)`, `run_errors(run_id)`.
4. `pnpm db:generate` → `0001_init.sql`; apply locally.
5. `config/defaults.ts` — every tunable from the spec with a typed default (schedule, weights, thresholds, budgets, models, dedupe, working days, retention). `config/settings.ts` — `getSettings()` merges DB overrides over defaults and validates with the shared Zod schema; cached per request/invocation.
6. Repos with typed methods (no raw SQL outside `db/`).

**Tests**
- Settings: defaults valid; partial overrides merge; invalid override rejected.
- Migration applies cleanly in vitest-pool-workers (use `applyD1Migrations` in setup).
- Repo smoke tests: insert/select runs, jobs unique constraint.

**Exit criteria:** schema migrated locally; `GET/PUT /api/settings` working end-to-end with validation.

---

### M2 — Pure parsing & normalisation core (1 day) — *highest test density*

**Tasks**
1. `core/parse/pay.ts` → `parsePay(text, hints)` returns `{ min, max, period, confidence }`. Handles: `£550 - £650 per day`, `£550-650pd`, `£600/day`, `up to £700 p/d`, `£45 per hour`, `£45ph`, `£80,000 - £90,000 per annum`, `£85k`, `£80k-£95k + bonus`, `Competitive`, `Market rate`, `negotiable`, `DOE`, `£500 - £550 per day Outside IR35`, ranges with en-dashes, missing £, `k` suffix, `pa`, `p.a.`. Heuristic fallback for bare numbers per SPEC §4.4.
2. `annualise(pay, workingDays)` and `formatPay()` ("£600/day", "£85k").
3. `core/parse/ir35.ts` — regex/keyword: outside/inside/"determination tbc"/unknown; handles "IR35: Outside", "inside IR35 (umbrella)", "PAYE/umbrella" → inside-leaning, "Ltd company" → weak outside signal (confidence tiers).
4. `core/parse/workMode.ts` — remote/hybrid/onsite + `onsiteDaysPerWeek` ("2 days a week in office", "1 day per month on site", "fully remote", "100% remote", "WFH").
5. `core/parse/employmentType.ts` — from Reed `contractType`/`jobType` + text.
6. `core/parse/text.ts` — HTML → plain text (strip tags, decode entities, collapse whitespace; preserve bullet breaks). Use a tiny hand-rolled converter or `html-entities`; no DOM in Workers.
7. `core/parse/title.ts` — `normaliseTitle()` (lowercase, strip "senior/lead/principal/jr" into a separate seniority field, remove punctuation, location tails like "- London"), `tokenSetRatio(a,b)`.
8. `core/normalise.ts` — RawJob (Reed shape) → NormalisedJob using the above.

**Tests**
- `fixtures/salaries.json`: ≥ 40 real UK salary strings with expected output; table-driven test.
- ≥ 15 IR35 / work-mode phrases each.
- Normalise 5 recorded Reed job fixtures (contract outside, contract inside, perm with salary, perm "competitive", remote).

**Exit criteria:** 100% branch coverage on `core/parse/*` (enforced with Vitest coverage thresholds for this folder).

---

### M3 — Reed adapter & manual fetch (½–1 day)

**Tasks**
1. `adapters/reed/client.ts` — `fetch` with Basic auth (`btoa(key + ':')`), 15 s timeout via `AbortSignal.timeout`, maps 401→non-retryable, 429/5xx→`UPSTREAM_RATE_LIMIT/ERROR` retryable, records each call to `source_calls` and `usage_daily.reed_calls`.
2. Zod schemas for Reed search + details responses (`.passthrough()` so unknown fields don't break; store raw JSON).
3. `adapters/reed/adapter.ts` implements `SourceAdapter`; maps profile → query params (`keywords`, `locationName`, `distanceFromLocation`, `contract`/`permanent` flags, `minimumSalary` only for perm-only queries, `resultsToTake=100`, `resultsToSkip=page*100`).
4. `core/budget.ts` — `canSpend(usage, settings, kind, n)` pure; used before calls.
5. Dev-only route `POST /api/dev/reed-probe { keywords, location }` (disabled unless `ENV=dev`) to eyeball real responses and **record fixtures** (`scripts/record-reed-fixture.ts`).

**Tests:** client against `fetchMock` (vitest-pool-workers) for 200/401/429/500/timeout; adapter query building; budget guard.

**Exit criteria:** with a real `REED_API_KEY` in `.dev.vars`, the probe returns normalised jobs; fixtures recorded and committed (strip nothing sensitive — adverts are public, but don't commit the key).

> **Verify here:** Reed field names, pagination behaviour and rate limits vs SPEC §4.1. Record findings in `DECISIONS.md`.

---

### M4 — CVs, profiles & embeddings (1 day)

**Tasks**
1. `POST /api/cvs` multipart (≤ 5 MB, `application/pdf` or DOCX MIME; sniff magic bytes `%PDF` / `PK`) → R2 `cvs/{id}/{filename}` → `DocParser.toMarkdown` → save `text_md`.
2. Enforce max 4 active CVs (409 with clear message).
3. `cvSummary` prompt → `structured()` → `summary_json` `{ headline, seniority, yearsExperience, skills[], sectors[], suggestedTitles[], suggestedKeywords[] }`.
4. Embedding text builder `cvEmbeddingText(cv)` → embed → `VectorStore.upsert` id `cv:{id}`, metadata `{ kind:'cv' }`.
5. On create: auto-create a `search_profile` pre-filled from summary + global defaults (contract+perm, London + Remote, 25 miles).
6. `PATCH /api/cvs/:id` (label, text_md, active) → re-summarise + re-embed when text changes. `DELETE` removes R2 object + vector + profile.
7. Profile routes `GET/PUT /api/profiles/:id` with Zod validation.
8. **UI — CVs & Profiles page:** drag-and-drop upload with progress, 4 slots, extracted-text editor (textarea with monospace + "Re-analyse" button), summary chips, profile form (tag inputs for titles/keywords/excludes/locations, numeric rate/salary, IR35 radio, work-mode toggles), active toggle. Toasts on success/error.

**Tests:** integration — upload fixture PDF with fake DocParser/LLM/Embedder; 5th active CV rejected; delete cascades. Web — profile form validation.

**Exit criteria:** upload 4 real CVs in dev (remote AI), see summaries and pre-filled profiles, edit and save.

---

### M5 — Ingest pipeline: schedule → fetch → process (1½ days)

**Tasks**
1. `core/schedule.ts` — `dueSlot(now, schedule, tz) → { slotKey } | null`; slot matches when local `HH` equals a slot hour and minutes < 60 (cron is hourly at :00). Pure; uses `Intl.DateTimeFormat('en-GB', { timeZone, … formatToParts })`.
2. `scheduled()` → `startRun({ trigger:'cron', slotKey })` if due; also runs `recoverStaleRuns()`.
3. `pipeline/startRun.ts` — insert run (unique `slot_key` → if conflict, exit); expand active profiles to queries (`job_titles × locations`, dedup query keys); increment `pending_ingest`; `bus.sendBatch(fetch msgs)`. Manual runs: `slot_key = manual:{ulid}`; reject if a run is already `ingest|scoring` (409).
4. `pipeline/fetchPage.ts` — budget check → `source.search` → `INSERT OR IGNORE` job refs (minimal row: source ids, title, url, posted_at, `stage='ref'`) → collect **newly inserted** ids → `job_profile_hits` for all refs → enqueue `process` for new ones (+ increment) → enqueue next page if `newCount > 0 && page+1 < maxPages` → decrement self.
5. `pipeline/processJob.ts` — steps per SPEC §5.2 Stage C:
   1. details + normalise (+ save)
   2. `core/filters.ts` `evaluateFilters(job, profiles, globalBlocklist) → { pass, reasons[] }` — job passes if it passes for **any** profile that found it; store `filter_reason` and create a group with `status='filtered'` for visibility.
   3. embed `jobEmbeddingText(job)` (title + employer + location + pay + first ~1,500 chars) → upsert `job:{id}` metadata `{ kind:'job', postedTs, groupId? }`.
   4. dedupe (M6 — stub: always new group in M5).
   5. similarity: fetch CV vectors once per invocation (memoise), cosine in JS (`core/scoring/prefilter.ts` exports `cosine`), save `job_cv_similarity`.
   6. prefilter score; `status='prefiltered'`.
   7. decrement; if 0 → `selectForScoring` (stub in M5 = mark run done).
6. Queue dispatcher in `index.ts` routes by `batch.queue`, processes messages with `Promise.allSettled` per batch, per-message ack/retry.
7. **UI — Runs page:** table (started, trigger, phase/status, fetched/new/filtered/dupes/prefiltered/scored, Reed calls, duration, errors), "Run now" button with live polling (TanStack Query `refetchInterval` while a run is active), run detail drawer with errors.

**Tests**
- `schedule.ts`: table tests incl. **last Sunday of March and October** transitions, Saturday (no slots), Sunday 17:00, double-fire same hour → same slotKey.
- Integration: full ingest with `FakeSource` (fixtures, 2 pages), fake embedder (deterministic hash-based vectors), in-memory `FakeVectorStore`; assert counts, filtered reasons, counters reach 0, idempotent redelivery of a `process` message doesn't double-count.
- Filters: table tests per rule incl. "unknown passes".

**Exit criteria:** "Run now" in dev ingests real Reed jobs for all profiles; Runs page shows accurate counts; re-running immediately adds ~0 new jobs.

---

### M6 — De-duplication (½–1 day)

**Tasks**
1. `core/dedupe.ts` — pure `isDuplicate(candidate, neighbour, settings) → { dup: boolean, why }` using cosine ≥ `dedupeSim`, plus (`tokenSetRatio(titles) ≥ 0.8` OR (pay overlap within ±10% AND same city)).
2. In `processJob` step 4: `vectors.query(vec, { topK: 5, filter: { kind:'job', postedTsGte: now-21d } })` → exclude self → load neighbour jobs from D1 → first dup wins → attach to its group; else create group.
3. Group join rules (SPEC §8): if group already assessed → copy nothing (assessment is per group), just update `last_seen_at`, keep status; if group is `skipped/applied/...` → don't resurface; increment `new_postings_since_action`.
4. `canonical_job_id` = posting with most complete data (has pay > has IR35 > longest description > earliest).
5. Concurrency: two near-identical postings processed in parallel could create two groups. Mitigate: after creating a group, re-query neighbours; if an older group (lower `first_seen_at`, tie on id) is a dup, **merge** into it (move jobs, delete newer group). Write `mergeGroups()` in repo, transactional (`db.batch`).

**Tests:** pure dedupe table tests (same role/different agency → dup; same title different city → not; same company different role → not); integration with 3 fixture postings of one role from 3 agencies → 1 group, 3 jobs; parallel processing race → merge leaves 1 group.

**Exit criteria:** real-data run shows grouped cards (verify in Runs counts: `dupes > 0` on a typical day).

---

### M7 — Selection, Llama assessment & final score (1–1½ days)

**Tasks**
1. `pipeline/selectForScoring.ts` — groups from this run with `status='prefiltered'`, `prefilter_score ≥ prefilterMin`, ordered desc, limit `maxLlmPerRun` (minus any `deferred` carried over from earlier runs, which go first) → `status='pending_llm'`, increment `pending_score`, enqueue `score`. Rest → `below_threshold`. If nothing selected → `finaliseRun`.
2. `ai/prompts/assess.ts` — `PROMPT_VERSION='assess@1'`; builds system + user from: job (canonical posting text ≤ ~3,500 tokens — approximate tokens as chars/4), all CV summaries, full text of top-2 CVs by similarity (≤ ~2,000 tokens each), profile preferences. Include explicit rubric:
   - 90–100 meets all essentials + most desirables, right seniority, prefs met
   - 75–89 meets essentials, minor gaps
   - 60–74 meets most essentials, notable gaps or pref conflicts
   - 40–59 partial fit
   - < 40 poor fit
3. `pipeline/assessGroup.ts` — `structured()` with assessment schema → post-validate (contact email/phone must appear verbatim in advert text; `best_cv_id` must be an active CV id, else use similarity best) → save assessment → merge extracted fields into canonical job where regex was `unknown` → compute `final_score` (`core/scoring/final.ts`) → `status='new'` → decrement → if 0 `finaliseRun`.
4. Budget exhausted → `status='deferred'` (not failed); next run picks it up first.
5. Model fallback when `neurons_est > 80%` of daily budget.
6. `finaliseRun` — counts summary JSON, `phase='done'`, `finished_at`; on the 17:00 slot also run `cleanup()` (retention per SPEC §11, deleting vectors too).
7. `POST /api/groups/:id/rescore`.

**Tests:** prompt builder snapshot tests (stable, truncation works); `structured()` with fake LLM returning: valid JSON, fenced JSON, invalid then valid (repair path), invalid twice (fallback), garbage (fail); post-validation strips hallucinated email; final score maths; deferred carry-over.

**Prompt evaluation harness (important for quality):** `scripts/eval-assess.ts` runs the real model over `test/fixtures/eval/*.json` (≈ 15 job+CV pairs with a human expected band, e.g. "75–89") and prints a table of score vs expected + JSON validity rate. Target: ≥ 95% valid JSON, ≥ 80% within band. Re-run whenever prompts change; bump `PROMPT_VERSION`.

**Exit criteria:** a real run produces ≤ 30 assessments with sensible scores; eval harness meets targets with the default model.

---

### M8 — Dashboard: Inbox, Job detail, Pipeline (2 days) — *the "slick" milestone*

**API (finish):** `GET /api/groups` with filters + **keyset pagination** (cursor = `final_score|id`), `GET /api/groups/:id`, `PATCH /api/groups/:id` (status transitions validated by a pure `canTransition(from,to)`; writes `status_history`; Applied requires `cvIdSent`), `GET /api/stats`. Use Hono RPC (`hc<AppType>`) so the client is fully typed.

**UI tasks**
1. **Inbox**
   - FilterBar (contract/perm segmented control, CV select, min-score slider, work mode, IR35, posted since, toggles for below-threshold/filtered); filters persisted in URL search params.
   - JobCard per SPEC §9.1: score ring + badge colour (Strong/Good/Maybe), title, company/agency, PayChip (normalised + "annualised £X"), IR35 chip, work mode + onsite days, contract length, posted age ("3h"), best-CV label, headline, 3 strengths (✓), 2 gaps (△), red-flag chips, "Also posted by" with highest rate highlighted.
   - Actions: Shortlist, Skip (opens SkipReasonPicker: chips, 1-key select), Open advert (new tab), Cover note.
   - **Keyboard:** `j/k` focus next/prev, `a` shortlist, `x` skip, `1–9` skip reason, `o` open, `c` cover note, `enter` open detail, `?` shortcuts dialog. Focus ring visible; actions **optimistic** (TanStack Query `onMutate`) with **Undo** toast (5 s).
   - Empty state: "You're all caught up — next scan at 12:00".
   - Skeleton loaders; no layout shift.
2. **Job detail drawer** (URL `/job/:groupId`, deep-linkable): tabs Overview (assessment, per-CV score bars, feedback adjustments explained), Postings (all agencies + links + pay), Advert (full description, sanitised HTML rendering via allow-list), Notes & history.
3. **Pipeline** — columns Shortlisted / Applied / Interview / Offer / Rejected (Skipped & Withdrawn behind toggle); drag between columns (dnd-kit) or status menu; Applied dialog asks CV sent + date; card shows "+2 new postings since you applied".
4. Header stats: new today, shortlisted, applied this week, next scan time, AI budget % used.
5. Responsive: usable on mobile (cards stack, drawer becomes full-screen).
6. Accessibility: semantic buttons, `aria-live` for toasts, colour + icon/text for badges (not colour alone), contrast AA in light/dark.

**Tests:** web component tests for JobCard rendering of unknown/partial data, keyboard handler, optimistic update + undo, status transition rules (pure, worker side); one Playwright smoke test (`apps/web/e2e/smoke.spec.ts`) against `pnpm dev` with seeded local D1: load Inbox → skip a job with `x` → it disappears → undo restores it.

**Exit criteria:** triage 20 jobs using only the keyboard in < 5 minutes; Lighthouse (desktop) performance ≥ 90, accessibility ≥ 95 on Inbox.

---

### M9 — Cover notes & feedback learning (1 day)

**Tasks**
1. `ai/prompts/coverNote.ts` (`coverNote@1`) — inputs: advert, chosen CV text, assessment strengths, kind (`cover_note` ≤ 200 words / `recruiter_message` ≤ 90 words), tone. Rules: UK spelling; only facts from CV; mirror 3–5 advert terms; no clichés list ("I am writing to express…", "passionate", "synergy"); end with a clear call to action. Output plain text (not JSON) → post-check word count, trim if over.
2. `POST /api/groups/:id/cover-note`, `GET` history; UI CoverNotePanel: kind + tone selectors, Generate, editable textarea, Copy (with toast), history list.
3. `core/scoring/feedback.ts` — pure `computeFeedbackAdj(input) → { adj, reasons[] }` per SPEC §10.2. Inputs gathered in `processJob` from repos: agency skip counts, previously-applied hiring companies, vectors of last 50 applied/shortlisted and last 50 `not_my_skills` skips (fetched via `vectors.getByIds`, cached per invocation).
4. Settings suggestions: `GET /api/settings/suggestions` — e.g. ≥ 5 `rate_too_low` skips in 14 days where max rate < current `min_day_rate + 50` → suggest new min; same for `location`, `inside_ir35` (→ suggest `outside_only`). UI: dismissible suggestion cards with "Apply" button.

**Tests:** feedback table tests (bounded −10..+10, reasons text); suggestions logic; cover note word-limit post-check; prompt snapshot.

**Exit criteria:** after skipping several agency-spam postings, the next run's cards from that agency show the penalty and the reason.

---

### M10 — Hardening, security & deploy (1 day)

**Tasks**
1. **Access auth middleware** — verify `Cf-Access-Jwt-Assertion` with `jose` (`createRemoteJWKSet(new URL(\`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs\`))`, `jwtVerify(token, jwks, { audience: ACCESS_AUD, issuer: \`https://${ACCESS_TEAM_DOMAIN}\` })`); allow-list the owner email (`OWNER_EMAIL` secret) as defence in depth. `DEV_BYPASS_AUTH` only honoured when `ENV=dev`.
2. Security headers on all responses (CSP: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`; `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`).
3. Advert HTML sanitisation (allow-list tags) server-side before storing `description_html`.
4. Input limits: body size, string lengths in Zod.
5. "Delete all data" (`DELETE /api/data` with typed confirmation phrase) → D1 truncate, R2 purge, Vectorize delete by stored ids.
6. Retention cleanup verified.
7. `deploy.yml`: on push to `main` → `pnpm check` → `pnpm db:migrate:remote` → `wrangler deploy` (secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
8. `RUNBOOK.md`: one-time setup commands (create D1, R2, Vectorize + metadata indexes, 4 queues + DLQ, secrets, Access application & policy), deploy, rotate Reed key, inspect DLQ, replay a run, tune thresholds.
9. Load sanity: seed 2,000 groups locally; Inbox API p95 < 300 ms (check query plans with `EXPLAIN QUERY PLAN`).

**Exit criteria:** production deploy behind Access; unauthenticated request to `/api/groups` → 401; first scheduled run in production completes; RUNBOOK followed from scratch by a fresh Claude Code session works.

---

### Timeline summary

| Milestone | Effort | Cumulative |
|---|---|---|
| M0 Scaffold | 0.5 d | 0.5 d |
| M1 Schemas/DB/settings | 0.75 d | 1.25 d |
| M2 Parsing core | 1 d | 2.25 d |
| M3 Reed adapter | 0.75 d | 3 d |
| M4 CVs & profiles | 1 d | 4 d |
| M5 Ingest pipeline | 1.5 d | 5.5 d |
| M6 Dedupe | 0.75 d | 6.25 d |
| M7 Assessment | 1.25 d | 7.5 d |
| M8 Dashboard | 2 d | 9.5 d |
| M9 Cover notes & feedback | 1 d | 10.5 d |
| M10 Hardening & deploy | 1 d | 11.5 d |

("d" = focused build-days of agent + review time; a usable end-to-end app exists after **M7** with a basic list view — M8 makes it slick.)

**Early-value shortcut:** if you want to see real scored jobs ASAP, after M5 add a temporary bare `GET /api/groups` table page, then continue.

---

## Part 4 — Testing strategy

| Layer | Tool | What | Target |
|---|---|---|---|
| Pure core (`core/**`) | Vitest (node) | Table-driven tests from real UK data | 100% branches on `core/parse`, ≥ 90% rest of core |
| Pipeline & HTTP | vitest-pool-workers | Real D1 (migrated per test file), real Queues/R2 emulation; fakes for Source/Vector/AI | Every stage + idempotency + budget paths |
| LLM quality | `scripts/eval-assess.ts` (manual, real AI) | Score bands + JSON validity | ≥ 95% valid, ≥ 80% in band |
| Web components | Vitest + Testing Library | Cards, filters, keyboard, optimistic updates | Key interactions |
| E2E smoke | Playwright (one spec) | Inbox triage happy path | Runs in CI against `pnpm dev` with `DEV_BYPASS_AUTH` and fake AI (`AI_MODE=fake`) |

**Fakes:**
- `FakeEmbedder`: deterministic — hash tokens into a 768-d bag-of-words vector, L2-normalised (so similar texts really are similar → dedupe/similarity tests meaningful).
- `FakeVectorStore`: in-memory brute-force cosine with metadata filtering.
- `FakeLlm`: queue of scripted responses, records prompts for snapshot assertions.
- `FakeSource`: serves recorded Reed fixtures by (keywords, page).
- `FakeClock`: settable `now`.

`AI_MODE=fake` env var makes `container.ts` use fakes for AI/Vector — lets the whole app run offline in CI and E2E.

---

## Part 5 — `CLAUDE.md` for the new repo (copy verbatim)

```markdown
# Job Scout — agent instructions

Read docs/SPEC.md (behaviour) and docs/IMPLEMENTATION_PLAN.md (structure, order) before any work.

## Workflow
- Work milestone by milestone (IMPLEMENTATION_PLAN Part 3). Do not skip ahead.
- Before finishing any task run `pnpm check`; it must pass. Never disable, skip or weaken a test to make it pass.
- Commit after each task with conventional commit messages.
- Record any deviation from the plan/spec, and every verified external fact (Reed fields, model IDs), in docs/DECISIONS.md.

## Architecture rules
- core/ is pure: no env, no fetch, no Cloudflare types. Put all logic you can here and test it table-driven.
- Bindings only via ports/ interfaces; real implementations in adapters/; wired only in container.ts.
- All DB access via db/repos. Schema changes only via drizzle schema + `pnpm db:generate`; never edit an applied migration.
- Every queue handler must be idempotent and must update run counters exactly once (processed_messages).
- Every tunable value comes from settings (config/defaults.ts), never a magic number inline.
- LLM calls only via ai/structured.ts (or the cover-note helper); prompts are versioned; bump PROMPT_VERSION on change.
- Zod schemas live in packages/shared; infer types, don't hand-write duplicates.

## Style
- TypeScript strict; no `any` (use `unknown` + parse). Biome formatting.
- Small functions; name things after the domain (group, posting, profile, run).
- UI: Tailwind, components in components/ui; every async action has loading, error and empty states; optimistic updates with undo for triage actions.

## Commands
pnpm dev | pnpm check | pnpm test | pnpm db:generate | pnpm db:migrate:local | pnpm cf:types | pnpm deploy

## Never
- Scrape websites. Only official APIs/RSS.
- Commit secrets (.dev.vars is gitignored).
- Send CV contents anywhere except Workers AI.
```

---

## Part 6 — Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reed API fields/limits differ from spec | Medium | Medium | M3 verification step + `.passthrough()` schemas + raw JSON stored |
| Llama returns invalid/low-quality JSON | Medium | High | JSON-schema mode, repair + fallback, eval harness gate in M7 |
| Workers AI neuron budget exceeded | Medium | Medium | Two-stage scoring, `maxLlmPerRun`, daily budget, fallback model, deferral |
| Vectorize eventual consistency hides just-inserted vectors from dedupe | High | Low | Merge-on-detect (M6.5); dedupe also checks D1 for same-run titles via `tokenSetRatio` |
| Duplicate cron fire / queue redelivery | Medium | Low | Unique `slot_key`, `processed_messages`, atomic counters |
| Run never finishes (counter drift) | Low | Medium | Stale-run recovery on hourly cron |
| CV parsing poor (tables/columns) | Medium | Medium | Editable extracted text + re-analyse |
| Similarity thresholds wrong for real data | High | Low | All thresholds in Settings; review after first week; log similarity distributions on Runs page |
| Scope creep into phase 2 | Medium | Medium | Phase 2 list in SPEC §17; anything new → `docs/BACKLOG.md` |

---

## Part 7 — How to kick off with Claude Code

1. Create the `job-scout` repo, add `docs/SPEC.md`, `docs/IMPLEMENTATION_PLAN.md`, and `CLAUDE.md` (from Part 5).
2. Get a Reed API key; have your Cloudflare account ID ready (Workers Paid plan recommended for Queues).
3. First prompt:
   > Read CLAUDE.md, docs/SPEC.md and docs/IMPLEMENTATION_PLAN.md. Implement **M0** exactly as described, run `pnpm check`, commit, and summarise what was done and anything that needs my input. Stop after M0.
4. Then one prompt per milestone: *"Implement M{n} per the plan. Stop when its exit criteria pass and summarise."* Review each before continuing — M2, M5 and M7 deserve the closest look.
5. Between M3 and M4, put `REED_API_KEY` in `apps/worker/.dev.vars` so real data flows from M5 onwards.

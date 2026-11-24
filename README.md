# agile-outcomes-site

Website for Agile Outcomes (agileoutcomes.co.uk).

- `public/` holds the site: `index.html`, `styles.css` and `app.js`. Everything in this folder is published.
- `wrangler.jsonc` tells Cloudflare to publish `public/`. Deploy command: `npx wrangler deploy`. No build command is needed.
- Preview locally with `python3 -m http.server 8000 --bind 127.0.0.1` from inside `public/`.
- Contact email: edit `MAIL_USER` and `MAIL_HOST` at the top of `public/app.js`.

## Delivery dashboard (`/demo/`)

A single-column dashboard a CTO could read each morning: an overall insight, headline figures, then five charts over time (throughput, lead time, work in progress by age, flow of work, forecast against delivery). Each chart has labelled axes, gridlines, a legend, tooltips and a short written insight.

- `src/index.js` is a Cloudflare Worker. It serves `/api/flow` and passes everything else to `public/`.
- `src/sources.js` lists the public trackers the dashboard can show. `/api/flow` serves the default; `/api/flow?p=engine` serves the second one, with its own caches and commentary. The second source is too large to read item by item on the free plan, so its cumulative-flow and work-in-progress-over-time charts are built from about forty count queries (how many items were in progress on each sampled date), (each week also reads the raised dates of the items in progress, giving their age), made in a separate request (`/api/flow?p=engine&h=1`) and kept for an hour. Items raised and finished come exactly from the main data; items in progress are sampled and joined with straight lines. Both tabs show exactly the same charts. A source can also list `stages` to get an optional pipeline view (one count query per stage); neither does at the moment.
- `src/metrics.js` computes the numbers (pure functions, no people data) and the `facts` object that commentary is written from.
- `src/insights.js` asks Workers AI for the commentary. It sends only `facts`, in a neutral analyst voice, and rejects any reply that is malformed, names the data source, or uses a number that is not in `facts`. It tries twice, then gives up quietly.
- Caching: the numbers are reused for 10 minutes. Commentary is regenerated in the background when it is older than 10 minutes, so visitors never wait for the model and the browser never calls it. The last good commentary is kept for 7 days as a fallback. If the model is unavailable or the free daily allowance runs out, the charts still show, without commentary.
- `public/showcase.js` draws the charts. The home page fetches `/api/flow` when idle so the data is warm when the dashboard opens.

Model: `@cf/meta/llama-3.1-8b-instruct-fast`. Set an `INSIGHT_MODEL` variable in Cloudflare to try another Workers AI text model.

Tests: `node test/metrics.test.mjs`, `node test/insights.test.mjs`, `node test/worker.test.mjs` (the last two use a fake model and a fake data source).

Cloudflare: the `AI` binding is declared in `wrangler.jsonc`, so Workers Builds adds it on deploy. Locally, `wrangler dev` reaches Workers AI over your Cloudflare account, so run `npx wrangler login` once first; without it the page simply shows no commentary.

## Release metrics (`/demo/dora/`)

DORA-style measures for a public project, built by linking its Jira tickets to its GitHub pull requests: release cadence, lead time for changes (split into time in review and time waiting for a release), change failure rate, and time to restore. The project is Apache Kafka (`scripts/dora-sources.mjs`): its pull requests are titled `KAFKA-12345: ...` and its Jira versions carry release dates.

**It is not computed in the Worker.** A year of pull requests is about 70 pages of GitHub data, far beyond the free plan's 50 subrequests per request. Instead a Node script builds a static file and the page draws it.

- `scripts/build-dora.mjs` fetches, links and writes `public/data/dora-kafka.json`. `scripts/lib/dora-fetch.mjs` does the fetching (Jira search and versions, GitHub pulls list), with the fetch function injected so tests can fake it.
- `public/lib/dora.js` holds the pure analysis and the findings. `public/dora.js` and `public/dora.css` draw the page.
- Only ticket keys, version names, priorities and dates are kept. Pull request titles are read to find a ticket key and dropped. No people.
- "Release" means a Jira version marked released (names like `3.7.0`, not release candidates). Lead time runs from the first pull request for a ticket being opened to the release date of the first release containing it. A change failure is a Blocker or Critical bug that names a release as affected, raised within 30 days of it. Time to restore runs from that bug being raised to the release that fixed it.
- Pull requests are read 150 days further back than the release window, because merged work can wait months for a release. Releases too early to be covered are left out of lead time, and the page says where coverage starts.

Run it (a GitHub token with no scopes is enough; without one GitHub allows 60 requests an hour):

```bash
GITHUB_TOKEN=ghp_xxx node scripts/build-dora.mjs --probe     # fetch and print what was found, write nothing
GITHUB_TOKEN=ghp_xxx node scripts/build-dora.mjs             # write public/data/dora-kafka.json
```

Commit the JSON to publish it. Until it exists the page says the metrics are being prepared. To refresh it on a schedule, a GitHub Action can run the script with the built-in `GITHUB_TOKEN` and commit the file (not included: it writes to `main`).

`/demo/dora/?sample=1` previews the page from `public/data/dora-sample.json`, a simulation labelled as synthetic on the page. Regenerate it with `node scripts/make-dora-sample.mjs`.

Test: `node test/dora.test.mjs` (hand-built cases with known answers, plus the fetcher against fake GitHub and Jira servers that use the real response shapes).

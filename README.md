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
- `public/lib/metrics.js` computes the numbers (pure functions, no people data) and the `facts` object that commentary is written from. `public/lib/signals.js` works out the findings from them. Both live under `public/` because the browser loads them too (see "Your data" below); the Worker imports them from there.
- `src/insights.js` asks Workers AI for the commentary. It sends only `facts`, in a neutral analyst voice, and rejects any reply that is malformed, names the data source, or uses a number that is not in `facts`. It tries twice, then gives up quietly.
- Caching: the numbers are reused for 10 minutes. Commentary is regenerated in the background when it is older than 10 minutes, so visitors never wait for the model and the browser never calls it. The last good commentary is kept for 7 days as a fallback. If the model is unavailable or the free daily allowance runs out, the charts still show, without commentary.
- `public/showcase.js` draws the charts. The home page fetches `/api/flow` when idle so the data is warm when the dashboard opens.

Model: `@cf/meta/llama-3.1-8b-instruct-fast`. Set an `INSIGHT_MODEL` variable in Cloudflare to try another Workers AI text model.

Tests: `node test/metrics.test.mjs`, `node test/insights.test.mjs`, `node test/worker.test.mjs` (the last two use a fake model and a fake data source).

Cloudflare: the `AI` binding is declared in `wrangler.jsonc`, so Workers Builds adds it on deploy. Locally, `wrangler dev` reaches Workers AI over your Cloudflare account, so run `npx wrangler login` once first; without it the page simply shows no commentary.

## Your data tab (`/demo/#yours`)

Visitors drop in a CSV export from Jira, Linear or Azure DevOps and get the same dashboard on their own data. It runs entirely in the browser: the file is read with the File API and nothing is uploaded, stored or sent anywhere.

- `public/yourdata.js` wires the file input, drag and drop, the example buttons and the "How the file was read" panel (column selectors, status grouping). `public/showcase.js` draws whatever report it is given through `window.AOShowcase`.
- `public/lib/csv.js` parses the CSV (quotes, line breaks inside cells, `,` `;` or tab), finds the columns by header name (first match wins, so repeated names such as Labels are fine), reads dates (`13/Mar/26 9:41 AM`, ISO, day-first or month-first numeric, decided from the whole file), groups statuses and builds the same `report` the live demos use by calling `buildReport`. Only keys, status names and dates are read: never titles, descriptions or people.
- "Now" is the latest date in the file, so an older export shows its own last 26 weeks. The forecast clears the real open backlog.
- Items closed without being delivered (resolution Won't Do or Duplicate, status Cancelled) are left out of throughput and lead time.
- A plain Jira export has no status history, so the cumulative flow and work-in-progress-over-time charts are only drawn when at least 70% of finished or in-progress items have a start date (Linear's Started, Azure DevOps' Activated Date, or Jira's Status Category Changed for items still in progress). Otherwise the snapshot of work in progress by age is shown, with a note saying why.
- Findings come from `signals.js`, the same text the live demos fall back to. No model is involved.
- `public/lib/sample.js` simulates a fictional team and writes it as a Jira-style or Linear-style export, with dates relative to today. The page uses it for the example buttons and the download links. Jira-style files have repeated column names, multi-line descriptions and Jira's date format on purpose.
- Test: `node test/csv.test.mjs`.

# agile-outcomes-site

Website for Agile Outcomes (agileoutcomes.co.uk).

- `public/` holds the site. Everything in this folder is published. Pages: `index.html` (home), `delivery/`, `backlog/`, `outcomes/`, `outcome-partner/` (one page per offer) and `demo/` (Live Demos hub plus the dashboard below). Shared styles in `styles.css`, shared script in `app.js`.
- Offer pages follow one template (headline, problem, demo panel, what you get, built in your tools, objection, price, next step, proof). Prices are list crossed out plus introductory price; they are draft figures, marked with comments in the HTML.
- The Backlog and Outcomes demo panels are curated examples. A live demo replaces the contents of `.demo-body` inside `.demo-panel`. The Delivery page embeds `/demo/?embed=1&compact=1` (just the headline figures and the first chart) in an iframe, because the full dashboard is very tall; the full thing lives at `/demo/`.
- Contact: any link with `data-mail="Subject"` becomes a mailto link to the address in `app.js`.
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

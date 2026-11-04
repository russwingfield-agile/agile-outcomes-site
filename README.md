# agile-outcomes-site

Website for Agile Outcomes (agileoutcomes.co.uk).

- `public/` holds the site: `index.html`, `styles.css` and `app.js`. Everything in this folder is published.
- `wrangler.jsonc` tells Cloudflare to publish `public/`. Deploy command: `npx wrangler deploy`. No build command is needed.
- Preview locally with `python3 -m http.server 8000 --bind 127.0.0.1` from inside `public/`.
- Contact email: edit `MAIL_USER` and `MAIL_HOST` at the top of `public/app.js`.

## Delivery dashboard (`/demo/`)

A single-column dashboard a CTO could read each morning: an overall insight, headline figures, then five charts over time (throughput, lead time, work in progress by age, flow of work, forecast against delivery). Each chart has labelled axes, gridlines, a legend, tooltips and a short written insight.

- `src/index.js` is a Cloudflare Worker. It serves `/api/flow` and passes everything else to `public/`.
- `src/metrics.js` computes the numbers (pure functions, no people data) and the `facts` object that commentary is written from.
- `src/insights.js` asks Workers AI for the commentary. It sends only `facts`, in a neutral analyst voice, and rejects any reply that is malformed, names the data source, or uses a number that is not in `facts`. It tries twice, then gives up quietly.
- Caching: the numbers are reused for 10 minutes. Commentary is regenerated in the background when it is older than 10 minutes, so visitors never wait for the model and the browser never calls it. The last good commentary is kept for 7 days as a fallback. If the model is unavailable or the free daily allowance runs out, the charts still show, without commentary.
- `public/showcase.js` draws the charts. The home page fetches `/api/flow` when idle so the data is warm when the dashboard opens.

Model: `@cf/meta/llama-3.1-8b-instruct-fast`. Set an `INSIGHT_MODEL` variable in Cloudflare to try another Workers AI text model.

Tests: `node test/metrics.test.mjs`, `node test/insights.test.mjs`, `node test/worker.test.mjs` (the last two use a fake model and a fake data source).

Cloudflare: the `AI` binding is declared in `wrangler.jsonc`, so Workers Builds adds it on deploy. Locally, `wrangler dev` reaches Workers AI over your Cloudflare account, so run `npx wrangler login` once first; without it the page simply shows no commentary.

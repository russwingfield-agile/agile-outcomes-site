# agile-outcomes-site

Website for Agile Outcomes (agileoutcomes.co.uk).

- `public/` holds the site: `index.html`, `styles.css` and `app.js`. Everything in this folder is published.
- `wrangler.jsonc` tells Cloudflare to publish `public/`. Deploy command: `npx wrangler deploy`. No build command is needed.
- Preview locally with `python3 -m http.server 8000 --bind 127.0.0.1` from inside `public/`.
- Contact email: edit `MAIL_USER` and `MAIL_HOST` at the top of `public/app.js`.

## Live demo (showcase)

`src/index.js` is a Cloudflare Worker that serves `/api/flow` and passes everything else to the static assets in `public/`.
It reads the public Jira project JRACLOUD (jira.atlassian.com, anonymous), computes flow metrics in `src/metrics.js`, and caches the result for 10 minutes.
The dashboard lives on its own page, `public/demo/index.html` (served at `/demo/`); `public/showcase.js` loads the data and draws five SVG panels. The home page quietly fetches `/api/flow` when idle so the data is cached by the time the demo opens. Run `node test/metrics.test.mjs` to check the calculations.

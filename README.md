# agile-outcomes-site

Website for Agile Outcomes (agileoutcomes.co.uk).

- `public/` holds the site: `index.html`, `styles.css` and `app.js`. Everything in this folder is published.
- `wrangler.jsonc` tells Cloudflare to publish `public/`. Deploy command: `npx wrangler deploy`. No build command is needed.
- Preview locally with `python3 -m http.server 8000 --bind 127.0.0.1` from inside `public/`.

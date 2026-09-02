# UMD Dining Nutrition

Scrapes UMD Dining's nutrition site into SQLite and publishes static JSON, so I can
work out what to eat while standing in a dining hall.

- [DATA-FLOW.md](DATA-FLOW.md) — how data moves: scrape, store, export, publish, phone
- [TODO.md](TODO.md) — what's still open
- [GOALS.md](GOALS.md) — what this is for
- [SCHEMA.md](SCHEMA.md) — data model, and every quirk of the source site
- [FRONTEND-PLAN.md](FRONTEND-PLAN.md) — the front end spec (stale after step 7)

## Running it

```sh
python -m venv .venv
.venv/Scripts/pip install requests beautifulsoup4 lxml pytest

.venv/Scripts/pytest -q                     # 122 tests, no network
.venv/Scripts/python scripts/daily_scrape.py --days 7
```

Label pages are fetched once and cached forever, so re-runs make almost no requests.
Every page fetched is also saved to `cache/`, which means the whole database can be
rebuilt offline after a parser change.

## Politeness

Two requests a second, single threaded, descriptive User-Agent, retries with backoff.
The site publishes no `robots.txt` and therefore no crawl-delay. Daily runs fetch only
the menu pages plus genuinely new items — a cold start is the only bulk fetch.

## Status

Back end complete. Front end steps 1-11 built and live at
<https://aysinghal.github.io/umd-nutrition/> — GitHub Pages serves `main` from
`/docs`. A GitHub Action re-scrapes and republishes every day at 09:00 UTC.

Front end tests are four Node scripts, 78 assertions:

```sh
node scripts/sw-test.mjs
node scripts/marks-test.mjs
node scripts/search-test.mjs
node scripts/history-test.mjs
```

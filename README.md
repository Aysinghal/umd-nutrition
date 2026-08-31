# UMD Dining Nutrition

Scrapes UMD Dining's nutrition site into SQLite and publishes static JSON, so I can
work out what to eat while standing in a dining hall.

- [GOALS.md](GOALS.md) — what this is for
- [SCHEMA.md](SCHEMA.md) — data model, and every quirk of the source site
- [HANDOFF-FRONTEND.md](HANDOFF-FRONTEND.md) — the front end, still being planned

## Running it

```sh
python -m venv .venv
.venv/Scripts/pip install requests beautifulsoup4 lxml pytest

.venv/Scripts/pytest -q                     # 120 tests, no network
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

Back end complete. Front end not started.

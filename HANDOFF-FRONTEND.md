# Handoff: planning the front end

**Answered — the resulting spec is in [FRONTEND-PLAN.md](FRONTEND-PLAN.md).** This file
stays as the record of what was asked and why.

Read this, then **ask me questions** to work out what the app should be. Don't start
building. We're planning pages and how things work first.

Background is in [GOALS.md](GOALS.md) (what I want and why) and [SCHEMA.md](SCHEMA.md)
(data model and every quirk of the source site). This file is the short version plus
the questions still open.

## Where the project is

The whole back end is done and working. 120 tests pass.

- Scrapes UMD Dining's nutrition site into SQLite. 1,586 items, 11,623 menu rows,
  3 halls × 7 days.
- Every page ever fetched is cached to disk, so the database can be rebuilt with zero
  network requests.
- A diet classifier assigns each item a level for my vegetarian/chicken/no-beef ladder.
- A plausibility checker flags items whose numbers can't be true.
- Exports static JSON for the phone app. **That JSON is the only thing the front end
  touches.**

The front end has not been started. No HTML, no CSS, no JS exists yet.

## What I'm building and why

A page I open on my phone **standing in a dining hall, about twice a day**, to decide
what to put on my plate — and then afterwards, to read the numbers of what I ate into
FoodNoms, which is where I actually track macros.

Those are the same screen: a plate I add items to and watch running totals on. Before
the meal it's a plan, after the meal it's a record.

This is for me and maybe two friends. Not a product.

## Decisions already made — don't reopen these

- **Static site on GitHub Pages.** No server, no backend, no login. A scheduled GitHub
  Action runs the scrape daily and commits updated JSON.
- **All personal state lives in browser local storage.** Targets, favorites, hidden
  items, custom ordering, plates. Nothing user-specific server side — that's why there's
  no auth.
- **Phone first.** A laptop CLI exists for scraping and debugging; it is not the product.
- **Default ranking is protein per calorie**, with a minimum-protein floor (10 g works
  well in practice) so garnishes don't win. Ratio, not fixed thresholds.
- **Hall is a top-level selector** — I pick where I'm going, then look at that hall.
  A "which hall should I go to" comparison is a nice-to-have that comes last.
- **Targets on calories, protein, carbs, fat, fiber.** Each has a number *and* an on/off
  switch, so some are real targets and some are just numbers I can see. Stored defaults,
  overridable for a single meal.
- **Nutrition Facts label render, both per item and for the whole plate.** FoodNoms can
  scan a label off a screen — confirmed working — so this is how food gets logged
  without typing.
- **One month of menu history**, browsable by date. Plus my saved plates kept locally
  for a month, so a meal I forgot to log is still there.
- **Flagged bad-data items are hidden by default with a toggle**, and whenever one is
  shown it must carry a visible note saying the numbers aren't real.

## The data contract

Three files, fetched from `data/` (served by Pages from `docs/`). Sizes are the real ones.

**`index.json`** (~2 KB) — what exists.

```json
{"generated_at":"2026-08-31T16:15:00","classifier_version":1,
 "halls":[{"id":16,"name":"South Campus"},
          {"id":19,"name":"Yahentamitsi Dining Hall"},
          {"id":51,"name":"251 North"}],
 "dates":["2026-08-31","2026-09-01"],
 "days":[{"date":"2026-09-05","hall":16,"status":"ok",
          "meals":["Brunch","Dinner"],"items":667}],
 "counts":{"items":1586,"entries":11623}}
```

**`items.json`** (454 KB raw, **61 KB gzipped**) — every item, keyed by id.

```json
"119370*1":{"name":"French Toast","serving":"1 ea",
  "cal":251,"protein":10.9,"fat":10.5,"sat_fat":4.1,"trans_fat":0,
  "carbs":26,"fiber":2,"sugar":6.8,"added_sugar":0,"sodium":307.7,"chol":248.6,
  "diet_level":1,
  "tags":{"allergen":["alcohol","dairy","egg","gluten","soy"],"diet":["vegetarian"]},
  "allergens":["Dairy","Eggs","Gluten","Soybeans","Alcohol"]}
```

**`menu/<hall>-<date>.json`** (~8 KB raw, **1 KB gzipped**) — one hall, one day.

```json
{"date":"2026-09-05","hall":19,"hall_name":"Yahentamitsi Dining Hall",
 "meals":[{"meal":"Brunch","stations":[
   {"station":"Al Forno Pastas","items":["115022*6","115031*6"]}]}]}
```

**First load is ~63 KB gzipped** (index + items + one day). Every later day is ~1 KB,
because the browser caches `items.json`.

### Things the front end must handle

- **Any macro can be `null`.** The site prints `- - -` when it has no figure. `null` is
  not zero. An item with unknown protein must not sort as zero-protein or slip through a
  "under 5 g fat" filter.
- **`"no_data": true`** — 13 items have no nutrition information at all. They're real
  menu items and still appear on the menu; they just have nothing to show.
- **`"suspect": "<reason>"`** — 29 items whose numbers can't be true, e.g. `"20160
  calories for one 1 ea"`, `"macros weigh 889g in a 113g (4 oz) serving"`. Hidden from
  rankings by default; the reason string is written to be displayed as-is.
- **`diet_level` can be `null`** — 4 items can't be classified. These must never pass a
  vegetarian filter. Treat null as "not allowed at any level" and say why.
- **Both keys are absent when they don't apply.** Missing means fine.
- **Meals vary by day.** Weekdays are Breakfast/Lunch/Dinner; weekends are
  **Brunch/Dinner**. Never hardcode three meals. `meals` is a list so its order is real.
- **The same item appears at several stations in one meal** — 87 such cases in one day
  at one hall. Deduplicate for ranking; station still matters for "where do I walk".
- **Station names are the physical counter** — "Purple Zone", "Broiler Works",
  "Mongolian Grill", "Salad Bar". 23 of them at one hall. This is the "where is it" label.

### Diet levels

`diet_level` is an integer, and the whole filter is `diet_level <= my_level`.

| level | means | items |
|---|---|---|
| 1 | vegetarian only | 1,177 |
| 2 | + chicken/turkey | 169 |
| 3 | any meat except beef | 165 |
| 4 | anything | 71 |
| null | can't tell | 4 |

I switch levels day to day, so changing it needs to be quick.

## Real data facts that should shape the design

- **Portions are small.** 3–4 oz is the most common serving. Only ~4% of items have 30 g
  of protein or more.
- **My original example query returns nothing.** ">30 g protein and <500 cal for dinner"
  matched zero items at Yahentamitsi — the best item there that night was 26.3 g. **I
  hit targets by stacking two or three items, not by finding one hero item.** The plate
  with running totals is the real interface; per-item filtering supports it.
- A typical dinner at one hall is ~330 menu rows across ~23 stations, so the list needs
  ranking and filtering to be usable at all — it is far too long to scroll.

## Questions to work through with me

Roughly in the order I'd want to think about them. Ask a few at a time, not all at once.

**Screens and navigation**
1. What do I see when I open it? How much tapping before I'm looking at food?
2. One page with tabs, or separate screens? Which screens exist?
3. Should it remember my last hall and meal, and guess the meal from time of day?

**The recommended view — the main screen**
4. What's on a row? Name, station, calories, protein, ratio, tags — how much fits?
5. Flat ranked list, or grouped by station? Ranking argues flat; walking the hall argues
   grouped.
6. How do I change diet level and filters quickly with one hand?
7. How do favorites, hiding, and my saved custom ordering surface without cluttering it?

**The plate**
8. How do I add an item — tap the row, a button, something else?
9. Quantities: do I need "2 servings" or "half", and how does that work on a phone?
10. Where do running totals live so they're always visible?
11. How do targets show up — numbers, bars, something else? Remember some are off.
12. When does a plate clear? Manually, per meal, or on a new day?

**Search**
13. Should search default to the hall and meal I'm looking at, or everything?
14. Does it need to reach past days, for logging a meal I forgot?

**The FoodNoms label**
15. Where does the label appear — overlay, its own screen?
16. For the whole-plate label, what should it be called and what serving size does it claim?

**Settings, history, and edge cases**
17. Where do targets get edited, and how do the on/off switches work?
18. How do I browse the last month — past menus, past plates, or both?
19. What should an item with no data or suspect numbers look like on screen?
20. Does this need to work with no signal? Dining hall basements are not great for
    reception, and a service worker is the difference between working and a blank page.

## Practical setup

Mostly done — this section used to say none of it was.

- The project **is** a git repository, on `main`. Pages serves from `docs/`.
  Pages on a private repo requires GitHub Pro — free for students through the
  Student Developer Pack.
- The daily scrape **has** a GitHub Action on a cron
  ([.github/workflows/daily-scrape.yml](.github/workflows/daily-scrape.yml)), plus a test
  workflow. `scripts/daily_scrape.py` is what it runs.
- `cache/` and `umd.db` are gitignored. `docs/data/` **is** committed — currently
  `index.json`, `items.json`, and 21 menu files (3 halls × 7 days).

Genuinely still open: menu history retention is 7 days, not the month the plan assumes.
That's an exporter change, not a front-end one.

## How to run the back end

```
.venv/Scripts/python.exe -m pytest -q        # 120 tests, no network
```

Scrape and export are called from `umd_nutrition.scrape.scrape()` and
`umd_nutrition.export.export()`. There's no CLI wrapper yet — that was deferred, since
the phone app matters more.

## Style

Small personal tool. No premature abstraction. Comments only where something is
genuinely surprising. Ask before adding dependencies. Plain language in docs, no
marketing voice.

# What's left

Last updated 2026-09-01. Steps 1–11 of the front end are built and live; the back
end is done. This is everything still open.

For how the data actually moves, see [DATA-FLOW.md](DATA-FLOW.md).

---

## 0. Use it on a phone — this outranks everything below

Four steps shipped without a single one being touched in a dining hall. **The real
bug list comes from here, not from this file.**

Specifically unverified, because there's no headless browser and gestures, taps,
keyboard and layout genuinely cannot be tested from here:

- [ ] Does it open in airplane mode with the full list, instantly
- [ ] In airplane mode, does switching hall and date work for **every** hall and
      day — that's the 163 KB prefetch either working or not
- [ ] Does long-press on a row feel right at 450 ms, and does it avoid also firing a tap
- [ ] **Does the long-press highlight bug stay fixed** (shipped 2026-09-01, VERSION 12)
- [ ] Does the search keyboard behave, and does the 16px input stop iOS zooming on focus
- [ ] Does the date strip scroll sideways and centre today
- [ ] Does the save prompt fire when expected and not nag
- [ ] Does the 2-hour reload actually fire — force it by moving the phone's date
      forward a day, switching away, switching back
- [ ] Settings → Offline should say menu data is from today, with *Reload & update*
      underneath as the escape hatch

Two data points still owed from the original plan:

- [ ] A single-item label at a **fractional quantity (1.5×)** has never been
      scanned into FoodNoms. Whole-plate labels are confirmed working.
- [ ] Sorting by most protein puts a **pizza slice at 81.6 g protein** on top at
      Yahentamitsi. It passed the plausibility checker. Worth eyeballing in
      person — if it's wrong, it's a two-tap override now.

> Reminder: first load after a deploy is odd — the worker installs but isn't
> driving yet. Load once, reload, then it's automatic. Pages also holds a
> 10-minute cache; incognito bypasses it.

---

## 1. Is history retention working? — check the morning of 2026-09-02

**Time-sensitive.** Aug 31 disappeared from `index.json` one day after being
scraped, when it should have lasted 31 days.

Likely cause: the scraper's database lives in a GitHub Actions cache, not the
repo. The first automated run found no cache, started from an empty database, and
wrote only today-plus-seven. The original data came from a local run.

**The test: after the next scrape, is `2026-09-01` still in `index.json`?**

- **Still there** → the cache is working. The window fills out by one day each
  morning. Nothing to do.
- **Gone** → retention is broken. The date strip stays stuck at 7 days forever and
  step 11's saved-plate history has nothing to show. Needs a real fix — probably
  keeping the database somewhere that isn't an ephemeral cache.

Either way: **the entire 31 days of history hangs on that Actions cache
surviving.** If it's ever evicted, history resets to 7 days. That's a thin thread
for a shipped feature.

---

## 2. Dining hall hours → the data  *(approved, in progress)*

Back end only. **Nothing visible changes.**

Fetch the hours during the daily scrape and publish them in `index.json`:

```json
{ "date": "2026-09-01", "hall": 51, "meals": ["Breakfast","Lunch","Dinner"],
  "hours": { "Breakfast": "8am-10:30am", "Lunch": "10:30am-4pm", "Dinner": "4pm-10pm" } }
```

Source: the public Google Sheet that dining.umd.edu itself reads — per hall, per
meal, per date, a year ahead. **They are not on nutrition.umd.edu at all**; that
site has zero time strings anywhere.

~1 KB total, inside a file the app already downloads and already caches offline.

- New `umd_nutrition/hours.py`, one small table in `db.py`, a call in `scrape.py`,
  a few lines in `export.py`, new `tests/test_hours.py` with a saved copy of the
  sheet so it runs offline. No new dependencies.
- Stored in the database rather than fetched at export time, so the export keeps
  its no-network property — and if Google is down one morning you publish
  yesterday's hours instead of none.
- **Brunch is derived** (breakfast-start → lunch-end); the sheet has no Brunch row.
- **`Closed` is stored as-is** so step 3 can use it.

---

## 3. Show the hours in the sheets

Front end. The pick sheet already renders a subtitle per option, so this is
filling in a field that exists rather than new UI.

- Meal sheet: each meal gets its window underneath.
- Hall sheet: each hall gets today's hours, and can say when a hall is **closed**.
- `o.note` currently goes into the sheet as **raw HTML, unescaped**. Fine for
  strings we generate, but hours come from a spreadsheet other people edit —
  escape it before it goes on screen.

---

## 4. Use the hours for meal-picking and the staleness reload

Front end, behaviour change. Can't start before step 2 lands.

Today the app guesses the meal from one hardcoded table:

```
MEAL_ENDS = { Breakfast: 10.5, Brunch: 15, Lunch: 16, Dinner: 24 }
```

Three things wrong with it:

- **Dinner "ends" at midnight**, so at 10:30pm it confidently shows dinner at a
  hall that closed at 9pm.
- **Brunch is set to 3pm** when it actually runs to 4pm.
- **It can't be per hall.** 251 North serves dinner to 10pm, the other two to 9pm.
  On weekends South Campus breakfast starts at 10am, not 7am.

And the staleness reload currently asks a proxy question — *"is this page more
than 2 hours old?"* — instead of the real one: *"is the meal I'm showing still
the meal this hall is actually serving?"* That proxy both fires when nothing
changed (back at 3:00 after opening at 12:30) and misses when something did (back
at 4:05 after opening at 3:00 — dinner started, page is only 65 min old).

**Keep the date check regardless.** Crossing midnight means different menu files,
and hours say nothing about that.

**The fiddly part:** the meal sticks for an hour after it's decided so a reload
can't flip it under you mid-meal. That stickiness will fight a
meal-boundary-triggered reload — reload happens, sticky rule puts Lunch straight
back. The two have to be taught about each other, and a meal you picked by hand
must still win.

---

## 5. Search quality — open, waiting on real use

Search is plain case-insensitive substring matching, deliberately, for now.
Measured on the real export (1,561 items):

```
chicken   165        greens      3     ← misses kale, spinach, chard
rice       66        veggie      2     ← same intent as "vegetable"…
salad      52        vegetable  28     ← …15× the results
beans      42        protein     0     ← nothing at all
```

Good for *"I know roughly what it's called."* Useless for *"show me the vegetables."*

**Don't build anything until the current search has actually let you down and you
can say which queries failed.** Then build tags for those categories rather than
guessing at a taxonomy.

The two options, honestly:

- **Embeddings / vector search.** Embedding 1,561 items once in Python is sound —
  ~600 KB of vectors. The catch is the *query*: comparing typed text against those
  vectors means running the same model on the phone, ~25 MB plus a library. That
  breaks the zero-dependency, no-build-step rule.
- **Tags computed at scrape time** — the cheaper one, and what I'd try first. Do
  the semantic work in Python and ship the answer instead of the vectors. Tag
  "Collard Greens", "Sautéed Kale" and "Baby Spinach" all as `greens` and
  `vegetable`, then match name **or** tags. The `item_tags` table already exists
  and is already exported — this is adding rows, not building machinery. What it
  gives up is genuinely open-ended queries.

---

## 6. Smaller open items

- [ ] **Search widen button only appears on zero results.** You can get two
      mediocre local hits and have no way to ask for the wider search. Proposed
      fix: a quiet always-present line under the results — *"Search all halls
      instead."*
- [ ] **Exporter meal ordering.** Menu files list meals alphabetically while
      `index.json` has them chronologically. The front end works around it by
      always reading the index, but the two should agree at the source.
- [ ] **Settings sheet is getting long** — sort, floor, 13 allergens, flagged, 5
      targets, backup, offline. Collapsible sections *if it starts to annoy you*.
      Don't pre-empt it.

---

## 7. Known debt

- **`cache/` grows ~1 GB/year and nothing prunes it.** Menu HTML is 859 KB a page,
  three new URLs appear every day, and they're never deleted (43.5 MB today).
  It shares the Actions cache with `umd.db`, so filling it up would take the
  database down too. The growing part is also the useless part — menu HTML is
  never read back, since menu pages always bypass the cache on the way in.
  Fix is small: stop writing menu pages to the cache, or prune them by date.
- **Label pages are fetched once ever and never re-checked.** If UMD corrects a
  recipe's nutrition, we will never notice.
- **Diet classification is frozen at first sight.** Improving `diet.py` changes
  nothing for items already stored — `reclassify_all()` exists for that and is
  deliberately not wired into the daily run.
- **Three orphaned `2026-08-31` menu files** are still in `docs/data/menu/`
  (24 files for 21 days). The next Action run clears them now that the exporter
  deletes unlisted files. Self-resolving — just don't be confused by it.

---

## Explicitly not planned

- **A "which hall should I go to" comparison across all three halls.** Nice-to-have
  that comes last. Don't build it unless asked.

---

## Stale docs

`GOALS.md`, `SCHEMA.md` and `FRONTEND-PLAN.md` predate steps 8–11 and are stale on
anything after step 7. `HANDOFF-FRONTEND.md` was deleted 2026-09-01 — it was a
superseded planning document and is in git history if ever needed.

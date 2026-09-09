# What's left

Last updated 2026-09-09. Steps 1–11 of the front end are built and live; the back
end is done. This is everything still open.

For how the data actually moves, see [DATA-FLOW.md](DATA-FLOW.md).

---

## 0. Use it on a phone — this outranks everything below

Used in a dining hall once or twice as of 2026-09-09, but never deliberately
against the list below. **The real bug list comes from here, not from this file.**

Specifically unverified, because there's no headless browser and gestures, taps,
keyboard and layout genuinely cannot be tested from here:

- [ ] Does it open in airplane mode with the full list, instantly
- [ ] In airplane mode, does switching hall and date work for **every** hall and
      day — that's the 163 KB prefetch either working or not
- [ ] Does long-press on a row feel right at 450 ms, and does it avoid also firing a tap
- [ ] **Does the long-press highlight bug stay fixed** (shipped 2026-09-01, VERSION 12)
- [ ] Do the hours read right on the meal list and the hall list (VERSION 14)
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

## 1. History retention — RESOLVED, it works

Checked 2026-09-09. The window is filling out by one day each morning, exactly as
hoped:

```
Sep 1    7 days
Sep 9   15 days     Sep 1 -> Sep 15, and Sep 1 is still there
```

The Actions cache is surviving between runs. It will cap at 31 days. Aug 31 was
lost because the first automated run started from an empty database, which is a
one-off, not a recurring fault.

**The thin thread remains:** all of that history still lives in a GitHub Actions
cache with no durability guarantee. If it is ever evicted, history resets to 7
days and refills from scratch. Worth a real fix eventually, not urgent.

---

## 2 + 3. Dining hall hours — SHIPPED and live

Verified against the live site 2026-09-09: **42 of 45 hall-days carry hours.**

```
Wednesday   South Campus   Breakfast 7am-10:30am  Lunch 10:30am-4pm  Dinner 4pm-9pm
            251 North      Breakfast 8am-10:30am  Lunch 10:30am-4pm  Dinner 4pm-10pm
Saturday    South Campus   Brunch 10am-4pm        Dinner 4pm-9pm       <- derived
            251 North      Breakfast 8am-10:30am  Lunch 10:30am-4pm  Dinner 4pm-7pm
```

Only 2026-09-01 lacks hours: it was already in the past when the feature shipped,
so it was never in a scrape window. It rolls off the back on its own.

**Where the data comes from:** the public Google Sheet dining.umd.edu reads in the
browser. nutrition.umd.edu has no times on it at all. Fetched during the scrape,
stored in `hall_hours`, pruned with menu days, published inside `index.json`
(+1.5 KB raw, +84 bytes gzipped).

**What the app shows:**

- **Meal list** — each meal with its own window.
- **Hall list** — open to close for the whole day, one line per hall
  (`South Campus  7am – 9pm`). Deliberately *not* the current meal: asking the
  day rather than the meal is what lets a Brunch hall and a Lunch hall both get a
  line on the same Saturday.
- A summer day with a real hole prints both windows rather than one misleading
  range: `11am – 1:30pm, 5:30pm – 6:30pm`. During term there are no gaps at all
  (0 of 351 hall-days Jan-Apr and Sep-Oct); in summer every day has one.
- `Closed` is shown. **`TBD` is not** — UMD publishes it on dates it has not
  settled, 1,086 cells across a year, and it must never render as a time.
- A missing key means *unknown*, never *closed*. No line rather than a wrong one.

Verified over all 1,179 hall-days in a year of the real sheet: zero malformed
output. `sheet.js` also now escapes what it renders, since these strings come from
a spreadsheet other people edit.

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
- **The scrape runs about four hours late.** Scheduled 09:00 UTC, actually fires
  around 13:00 UTC (9am Eastern) on every run so far. GitHub delays scheduled jobs
  on free runners and promises nothing. It still lands before breakfast service
  ends at 10:30am, but with little room. If it ever slips further, schedule it
  earlier to absorb the drift.
- **UMD's site goes down sometimes.** Two of nine runs failed (Sep 4, Sep 8),
  both `ConnectTimeout` after four retries. That is the intended behaviour: the
  job fails loudly, publishes nothing, and the previous day's data stays live.
  Both dates were captured anyway on other runs, since every run scrapes a
  seven-day window. No action needed.
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

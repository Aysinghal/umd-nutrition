# How data moves through this app

Everything except the UI. Written 2026-09-01, against the code as it stands.

---

## The one idea

**Food is stored once. Days point at it.**

"Sliced Red Onion" is served 174 times in a week. Its calories are written down
**one time**, in `items.json`. Every menu day is just a list of *pointers* — item
ids sitting at stations inside meals, with no numbers in them at all.

That is why one whole day of menus is 7.8 KB while the food list is 447 KB. If
days carried their own numbers the export would be roughly ten times bigger and
would not open on cellular in a basement.

Hold onto this. Almost every other decision below follows from it.

---

## The whole picture

```
   nutrition.umd.edu                        (a public Google Sheet —
   menu pages + label pages                  hours, step 2, not built yet)
            |
            |  once a day, 09:00 UTC
            v
  +--------------------------------------------------------+
  |   GitHub Actions runner — a fresh Ubuntu box that       |
  |   is deleted when the job ends                          |
  |                                                         |
  |     1  FETCH    raw HTML     ->  cache/                 |
  |     2  PARSE    HTML         ->  Python objects         |
  |     3  STORE    objects      ->  umd.db  (SQLite)       |
  |     4  EXPORT   umd.db       ->  docs/data/*.json       |
  |     5  COMMIT   + push to main                          |
  +--------------------------------------------------------+
            |
            v
     GitHub repo, main branch
            |
            |  GitHub Pages redeploys, ~45 seconds
            v
     aysinghal.github.io/umd-nutrition/     (+ 10 min browser cache)
            |
            |  your phone
            v
     Service worker cache  ->  the app you look at
```

Three things worth noticing right away:

- **There is no server.** Nothing runs when you open the app. You are downloading
  files that were written hours ago.
- **The runner is thrown away.** Every morning starts on a brand new machine.
  Anything that has to survive from yesterday must be deliberately carried
  across — see *Where things live*, below.
- **Nothing you do on your phone goes back up.** The arrows only point one way.
  Your plate, favourites and targets never leave the device.

---

## Stage by stage

### 1. Fetch — asking UMD for pages

`umd_nutrition/client.py`, `scrape.py`

Two kinds of page, and **they are treated in opposite ways.** This is the whole
performance story, so it's worth being exact:

| | **Menu page** | **Label page** |
|---|---|---|
| What it is | one hall, one day, every meal | one recipe's nutrition panel |
| URL | `?locationNum=19&dtdate=9/1/2026` | `label.aspx?RecNumAndPort=145130*4` |
| Fetched | **every run, always, from the network** | **once, ever** |
| Why | menus change | `RecNumAndPort` is a stable recipe id — the numbers behind it never move |
| Per run | 21 (3 halls × 7 days) | ~5 |
| Size | **859 KB** each | 15 KB each |

So a normal morning is 21 big pages plus a handful of small ones. A cold start
with no database is ~1,600 label pages — about 13 minutes at two per second.

#### How the disk cache works

Every page ever fetched gets written to `cache/`, under the **SHA-256 of its full
URL**:

```
cache/0092c213…6331.html   the raw HTML
cache/0092c213…6331.json   a sidecar: { url, fetched_at, bytes }
```

The sidecar exists for exactly one reason: so a directory of 3,214 hash-named
files is still readable by a human. Nothing reads it in normal operation.

#### Menu pages: fetched fresh, but still written to cache

Here's the subtlety. The daily run passes `use_cached_menus=False`, which becomes
`cache_ok=False`:

```
cache_ok=False  ──►  skip the cache READ, go straight to the network
                     ──► but still WRITE the result to cache
```

So menu pages **bypass** the cache on the way in and **fill** it on the way out.
Your guess that we only fetch menu pages we haven't seen was wrong; your second
guess — refetch every time and re-parse — is the right one.

#### Label pages: two gates, and the first one isn't the cache

You guessed "check the cache, then fetch if it's missing." Close, but there's an
earlier and much more important gate:

```
   every item id found on today's 21 menu pages   (~11,600 rows, ~1,600 distinct)
                     |
   GATE 1 ──► is this id already a row in the `items` table?
              known_item_ids() reads the whole set once at the start of the run.
              YES (≈1,586 of them) ──► never queued. No fetch. No parse. Done.
              NO  (≈5 of them)     ──► queue it
                     |
   GATE 2 ──► is the HTML already in cache/ ?      (cache_ok=True here)
              YES ──► read it off disk, no network
              NO  ──► fetch it, 0.5s of politeness, write it to cache
                     |
                  parse it
```

**The database is the real filter, not the cache.** On a normal day gate 1 throws
away 99.7% of the work before a single request is made.

Gate 2 only earns its keep in one situation, but it's an important one: the
database is gone (Actions cache evicted) while `cache/` survived. Then every
label "fetch" is a disk read, zero network, and the whole database rebuilds in
seconds instead of 13 minutes.

#### What happens when a genuinely new label arrives

```
fetch from network
   └─► write cache/<hash>.html + .json          client._write_cache
   └─► parse_label(html)  ──► an Item object    label.py
   └─► implausible_reason(item)                 quality.py — runs INSIDE upsert_item
   └─► write rows: items, items_fts             db.upsert_item
   └─► classify(name, ingredients, tags)        diet.py
   └─► write row: item_diet                     db.upsert_item_diet
   └─► every 50 items: conn.commit()
```

That last line matters: a cold run is thousands of pages, and losing all of it to
an interruption at page 1,500 would mean starting over.

#### Yes, `cache/` grows forever — and you were right to ask

You spotted a real problem.

Re-fetching the *same* menu URL overwrites the *same* file, so that's fine. But
**the URL contains the date.** Every morning the 7-day window slides forward, so
three brand-new URLs appear, and the three that fall off the back are never
touched again — and never deleted. Nothing prunes `cache/`. Ever.

```
menu HTML   859 KB × 3 new URLs/day  =  2.6 MB/day  ≈  0.96 GB/year
label HTML  15 KB × ~5 new/day       =  negligible

today:  43.5 MB total   ( 18.5 MB menus / 21 files
                          25.0 MB labels / 1,586 files )
```

Why it actually bites: `cache/` rides in the GitHub Actions cache **next to
`umd.db`**, uploaded and downloaded on every single run. The repo-wide limit is
10 GB, and when it's hit GitHub evicts entries — which would take the database
with it.

And the irony is that the growing part is the *useless* part. The 25 MB of label
HTML is load-bearing: it's what makes a cold rebuild fast. The menu HTML is dead
weight the moment the run ends, because menu pages are never read from the cache
anyway.

**Not fixed yet.** The fix is small — either stop writing menu pages to the
cache, or delete cached menu pages older than the retention window.

### 2. Parse — turning HTML into facts

The question "do we re-parse things we already have?" has a different answer for
each of the two page types:

| | Re-parsed every run? | |
|---|---|---|
| **Menu pages** | **Yes, all 21.** | They were just fetched fresh. Meals, stations and which items appear all change day to day. |
| **Label pages** | **No. Parsed once, ever.** | Gate 1 means an already-known item's HTML is never even opened again. |

`menu.py` reads a menu page into meals → stations → items, and pulls the allergen
and diet icons off each row. It reads meal names from the **tab link text**, never
from the order the panes appear in, because on a Saturday pane 2 is Dinner where
on a Tuesday it is Lunch.

`label.py` reads one recipe's nutrition panel.

`diet.py` works out what meat an item contains from three sources at once — the
item's name, its ingredient text, and UMD's own icons. Any one of them finding
meat is enough. This exists because UMD's ingredient lists sometimes just *omit*
the headline protein: "Escovitch Tilapia" lists oil, vinegar, onions and peppers,
and no fish whatsoever.

#### The consequence of parsing labels only once

An item's **diet classification is frozen at the moment it was first seen.**
Improving the rules in `diet.py` would change nothing for the 1,586 items already
stored.

That's what `reclassify_all()` is for. It re-runs the classifier over every stored
item using the ingredient text already in the database — **no network at all** —
and rewrites every classification. It is deliberately *not* part of the daily run.
You call it by hand after changing the rules.

The one thing that *is* rewritten every run is tags: `replace_item_tags` deletes
and re-inserts an item's allergen/diet icons on every appearance. It's idempotent,
so writing the same tags 174 times a week is harmless.

### 3. Store — SQLite, the memory

`db.py`, into `umd.db`

**This is the only thing in the entire system that remembers anything between
runs.** The runner is destroyed every morning; `docs/data` is overwritten every
morning. `umd.db` is the accumulated knowledge.

Think of it as three separate piles that age at different rates:

```
┌─ PILE 1: THE FOOD ─────────────────── never deleted, grows forever ─┐
│                                                                     │
│  items          one row per recipe: name, serving, all 12 macros,   │
│                 allergen text, plausible?, has-nutrition?           │
│                 ~1,600 rows, keyed by RecNumAndPort                 │
│                                                                     │
│  item_diet      what meat it contains + its diet level (1-4)        │
│  item_tags      allergen and diet icons        4,449 rows           │
│  items_fts      a search index over names                           │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  menu_entries POINT at items,
                              │  by rec_num_and_port
                              │
┌─ PILE 2: THE POINTERS ──────┴────────── pruned at 31 days ──────────┐
│                                                                     │
│  menu_entries   date + hall + meal + station + item id              │
│                 "on Sep 1, at Yahentamitsi, at dinner, at the       │
│                  Grill station, they served 145130*4"               │
│                 NO NUMBERS IN IT.  11,610 rows                      │
│                                                                     │
│  menu_days      one row per hall-day: did it work, which meals      │
│                 were found, how many items.  21 rows                │
└─────────────────────────────────────────────────────────────────────┘

┌─ PILE 3: BOOKKEEPING ───────────────────────────────────────────────┐
│  locations      the 3 halls and their id numbers (16, 19, 51)       │
│  scrape_runs    one row per run: pages fetched, new items, errors    │
│  item_overrides unused by the phone app — corrections live in your   │
│                 browser's localStorage, not here                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Pile 1 never shrinks. Pile 2 does.** That asymmetry is deliberate: labels are
expensive to fetch and their numbers never change, so forgetting one only ever
costs you. Pointers are cheap and only describe a day that has already passed.

So after a year the database holds maybe 4,000 foods and only ever 31 days of
menus. The food pile is the valuable part; it's also the part that takes 13
minutes to rebuild from scratch.

### 4. Export — SQLite out to flat JSON

`export.py`, into `docs/data/`

The app is a static page, so the scrape has to leave behind files it can simply
download. Every export **rewrites all three shapes from scratch** — nothing is
ever edited in place, which is why the exported data cannot drift or leak.

#### `index.json` — the table of contents

This is the one you said you didn't recognise, and it's the most important of the
three even though it's the smallest. **It contains no food and no menus.** It
answers *"what exists?"* before anything else is downloaded.

```jsonc
{
  "generated_at": "2026-09-01T14:01:36",   // the version stamp — see below
  "classifier_version": 1,
  "halls":  [ { "id": 16, "name": "South Campus" }, … ],   // 3
  "dates":  [ "2026-09-01", … "2026-09-07" ],              // 7
  "days":   [                                              // 21 = 3 halls × 7 days
    { "date": "2026-09-01", "hall": 16, "status": "ok",
      "meals": ["Breakfast","Lunch","Dinner"], "items": 718 }, …
  ],
  "counts": { "items": 1561, "entries": 11610 }
}
```

It has **three jobs**, and they're unrelated to each other:

1. **It tells the app what to offer you at boot.** Which halls exist, which dates
   have data, which meals each hall serves that day, and whether a given hall-day
   worked at all (`status`). The hall and date chips are built straight off this.

2. **It is the authority on meal order.** The menu files list meals
   *alphabetically* — Breakfast, Dinner, Lunch — which is wrong for every weekday.
   `index.json` lists them chronologically. The app always asks the index, never
   the menu file. *(These two should agree at the source; making the exporter fix
   it is an open item.)*

3. **It is the cheap "is there anything new?" question.** At **0.4 KB gzipped**
   it's the only file the background sync fetches on a normal open. The sync
   compares `generated_at` against the last one it saw, and only if it differs
   does it pull the other 163 KB.

#### The other two

| File | What's in it | Size | Gzipped |
|---|---|---|---|
| `items.json` | every item and all its numbers, keyed by id, no wrapper object | 447 KB | 60 KB |
| `menu/19-2026-09-01.json` | one hall, one day: meals → stations → item **ids** | 7.8 KB | 1.4 KB |

`items.json` is rebuilt containing **only foods some surviving menu day still
points at** — a `WHERE rec_num_and_port IN (SELECT … FROM menu_entries)`. So it
shrinks by itself as days age out of pile 2, even though pile 1 keeps everything
forever.

**Ingredient text is deliberately dropped here.** It's the biggest field by far,
it only ever existed as classifier input, and leaving it out is what keeps the
first screen at 62 KB gzipped — small enough to open on cellular in a basement.

The export **runs with no network at all**. That's on purpose: it's why all 122
Python tests run offline, and it's a property worth protecting.

### 5. Publish — git is the delivery mechanism

The Action commits `docs/data` and pushes to `main`. GitHub Pages serves `/docs`
off that branch. There is no build step, no bundler, no deploy pipeline: **commit
is deploy.**

If nothing changed, it doesn't commit at all.

---

## Where things live, and what survives

### First, the thing that trips everyone up: `cache/` and `umd.db` are NOT in git

Look at `.gitignore`:

```
cache/
*.db
```

Both are **ignored**. They have never been committed and never will be. When you
clone this repo you get the code and the exported JSON — and no database at all.

So where does the database live? **In two completely separate places that never
talk to each other:**

```
   YOUR LAPTOP                          GITHUB ACTIONS
   ───────────                          ──────────────
   umd.db     3.8 MB                    umd.db     (in the Actions cache)
   cache/     47 MB                     cache/     (in the Actions cache)

   items:      1,586                    items:      1,561
   dates:  Aug 31 → Sep 6               dates:  Sep 1 → Sep 7
                    ▲                                    ▲
                    │                                    │
       whatever you last ran               what actually built the live site
       by hand. Frozen in time.            Updated every morning at 09:00 UTC.
```

Those are real numbers, read just now. **They disagree.** Your local database is
a stale snapshot from the last time you ran the scraper by hand; the Action's is
the real one.

**This is the entire reason for the "never run `export()` locally" rule.** Doing
it writes your laptop's stale view over `docs/data` — which is why it once
deleted a published day and resurrected an old one.

### So how does the Action's database survive, if it isn't committed?

Every morning the Action gets a **brand new Ubuntu machine that is deleted when
the job ends.** Nothing on it survives by default. So the workflow explicitly
saves and restores two folders using GitHub's **Actions cache** — a scratch
storage bucket attached to the repo:

```
09:00  fresh empty machine
   │
   ├── RESTORE  ──►  pull umd.db + cache/ out of the Actions cache
   │                 (this is the ONLY reason yesterday is remembered)
   │
   ├── scrape, store, export, commit, push
   │
   └── SAVE     ──►  push umd.db + cache/ back into the Actions cache
                     under a new key
        machine destroyed
```

The Actions cache is **a convenience feature with no guarantees.** GitHub will
delete an entry that hasn't been touched in 7 days, and evicts oldest-first once
a repo's caches total 10 GB.

**If it's ever evicted, the database is gone.** The next run starts from nothing,
re-fetches all ~1,600 labels, and writes only today-plus-seven — because that's
all it knows. Every past day vanishes. That is almost certainly what happened to
Aug 31: scraped locally, then the first automated run started cold.

### The full picture

| Thing | Where it lives | How it survives | How you'd lose it |
|---|---|---|---|
| Raw HTML (`cache/`) | Actions runner | Actions cache | evicted at 7 days idle or 10 GB — **and it grows ~1 GB/year** |
| The database (`umd.db`) | Actions runner | Actions cache | same — and losing it resets history to 7 days |
| Exported JSON (`docs/data/`) | **the repo** | **committed to git** | you can't, it's in history |
| The app (`docs/js`, `css`, `html`) | **the repo** | **committed to git** | you can't |
| Downloaded app + menus on your phone | Safari's storage | service worker caches | Safari evicts unused sites at 7 days — **unless it's on your Home Screen**, which exempts it |
| Your plate, favourites, targets, saved plates | your phone | `localStorage` | clearing Safari data. Nobody else can touch it — it never leaves the device |

The pattern: **anything in the repo is permanent, anything in a cache is
disposable.** The disposable stuff is disposable on purpose — it can all be
rebuilt from UMD's website. It just takes 13 minutes and loses your history.

---

## Retention — what gets deleted, and when

Four different rules, and they are not the same rule:

```
items            NEVER pruned. The database keeps every food it has ever seen,
                 forever. Labels are expensive; nothing is gained by forgetting.

menu_entries     Pruned at 31 days. The pointers are what age out, not the food.
menu_days

items.json       Rebuilt from scratch every export, containing ONLY foods that
                 some surviving menu day still points at. So it shrinks by
                 itself as days age out — it cannot leak, and it cannot go
                 stale, because it is never edited, only rewritten.

menu/*.json      Any file not written this run is deleted. Without this, every
                 pruned day would leave its file behind forever — about a
                 thousand dead files a year, all committed.
```

Right now there are **24 menu files for 21 days**. The three Aug 31 files are
left over from before the delete rule existed; the next Action run clears them.

---

## What triggers what

```
09:00 UTC daily  ──►  Daily scrape Action  ──►  scrape ──► export ──► commit ──► push
(≈5am Eastern,        (.github/workflows/         (that push then triggers Pages,
 menu is up but        daily-scrape.yml)           and also the Tests workflow)
 before breakfast)

any push to main ──►  Tests Action ──► pytest -q   (122 tests, all off saved
                                                    fixtures, never touches UMD)

you, by hand     ──►  workflow_dispatch, or
                      python scripts/daily_scrape.py
```

`concurrency: group: scrape` means two scrapes can never run at once and stomp on
each other's database.

### The rule about running the export locally

**Don't.** See *Where things live* above for why: your laptop's `umd.db` is a
different, staler database than the Action's. Running `export()` against it once
silently deleted a day of published menus and resurrected a stale one. Caught in
`git status`, but only by luck. Let the Action do exports.

---

## The phone side

### What a service worker is

A **service worker is a small program the browser installs for your website and
keeps running even when the page is closed.** It is not part of the page. It sits
*between* the app and the internet:

```
   BEFORE (a normal website)

     the app  ──────── asks for a file ────────►  the internet
                                                       │
              ◄──────── file, or an error ─────────────┘
                        (no signal = nothing works)


   AFTER (with a service worker)

     the app  ──── asks for a file ────►  SERVICE WORKER
                                             │
                                             │  "do I already have this?"
                                             │
                          YES ───────────────┤
                          hand it over       │
                          instantly          │
                                             │
                                             └── NO ──►  the internet
              ◄──────────────────────────────────────────┘
```

Every single request the app makes gets intercepted by it. That is the whole
trick, and it is the only reason the app works in airplane mode: the app doesn't
know or care that there's no signal, because it isn't talking to the internet in
the first place. It's talking to the worker.

The worker also keeps running **after you close the app**, which is what lets it
download tomorrow's menus in the background.

Ours is `docs/sw.js`, about 130 lines.

### What is stored on your phone — three separate boxes

You had this right. Making it explicit:

```
┌─ BOX 1 ── "umd-shell-v12" ──── the app itself ──────────────────┐
│  index.html, app.css, 18 .js files, 3 icons        ~128 KB      │
│  Version-stamped. A new VERSION replaces the whole box and      │
│  deletes the old one.                                           │
└─────────────────────────────────────────────────────────────────┘

┌─ BOX 2 ── "umd-data" ──────── the food data ────────────────────┐
│  index.json          the table of contents          2 KB        │
│  items.json          every food + its numbers     447 KB        │
│  menu/16-2026-09-01.json  ┐                                     │
│  menu/19-2026-09-01.json  ├─ 21 files: 3 halls    163 KB        │
│  ...                      ┘  x 7 days                           │
│                                                                 │
│  NOT version-stamped, deliberately. Shipping an app update      │
│  must never throw away the week of menus you are relying on     │
│  in a basement with no signal.                                  │
└─────────────────────────────────────────────────────────────────┘

┌─ BOX 3 ── localStorage, one key: "umd-nutrition" ───────────────┐
│  your plate, favourites, hidden items, targets, saved plates,   │
│  your nutrition overrides, which hall/meal/diet level you last  │
│  used, your sort and protein floor                              │
│                                                                 │
│  One JSON object. Never uploaded anywhere. Not in either cache, │
│  so an app update cannot touch it.                              │
└─────────────────────────────────────────────────────────────────┘
```

Boxes 1 and 2 are **mirrors of files that live on GitHub.** Box 3 exists only on
your phone and has no copy anywhere — which is exactly why there is a
backup/restore button.

### First visit — why you get one menu file, then twenty more

You asked why step 2 only fetches one menu file when we are supposed to have all
of them. **Both are true. It happens in two stages.**

```
STAGE 1 — get something on screen        (this is what YOU wait for)

   index.html + css + 18 js modules              ~128 KB
   index.json     what halls/dates/meals exist       2 KB
   items.json     every food's numbers             447 KB
   menu/19-2026-09-01.json    ONE file: your hall, today   7.8 KB
                                                ─────────────────
                                       about 62 KB gzipped, then the
                                       screen draws and you can use it

   Only one menu file, because you can only look at one hall on one day
   at a time. Downloading the other twenty first would just make you wait.


STAGE 2 — fill in the rest    (background, seconds later, you never see it)

   the service worker wakes up and pulls
   the OTHER 20 menu files                       ~155 KB

   Now every hall on every day works with no signal.
```

So: **the screen needs one file, airplane mode needs all twenty-one.** Stage 1
serves the first need, stage 2 serves the second, and stage 2 never makes you
wait for it.

One oddity worth knowing: on the *very* first load the worker is still installing
and is not intercepting requests yet. So **after a deploy: load once, reload, and
then it is automatic.**

### "Cache-first" — what that actually means

When you open the app, the service worker answers **every** request from its
saved copy **without asking the internet at all.** Not "check for a newer version
and fall back to the cache" — it does not check. It just hands over what it has.

```
   you open the app
        │
        ▼
   need app.js?         ──►  in Box 1? ──► YES ──► here you go   (instant)
   need items.json?     ──►  in Box 2? ──► YES ──► here you go   (instant)
   need today's menu?   ──►  in Box 2? ──► YES ──► here you go   (instant)
        │
        ▼
   screen is drawn. Zero network requests. Works in a basement.
```

**Why it is built this way:** you are standing in a dining hall with one bar of
signal, deciding what to eat. Opening in half a second with a menu that is a few
hours old beats waiting six seconds for one that is current. The menu barely
changes between 5am and 6pm anyway.

The obvious cost is that you might be looking at slightly old data. That is what
the next two pieces exist to handle.

### The background sync — catching up, quietly

Right after the screen is drawn — and again whenever you come back after being
away 5+ minutes — the app taps the service worker on the shoulder and says "check
whether there is anything new."

```
   fetch index.json    (2 KB, 0.4 KB gzipped)
        │
        │  compare its "generated_at" against the one we saved last time
        │
        ├─► SAME  ──►  stop. Nothing to do.
        │              * this is what happens almost every time.
        │                One 2 KB fetch and it is over.
        │
        └─► DIFFERENT ──►  there is a new export. Pull:
                             items.json          447 KB
                             all 21 menu files   163 KB
                           then delete any cached day that fell out of
                           the window, then save the new stamp.
```

Three things about this are deliberate:

- **It grabs the whole week, not just today.** 163 KB buys every hall on every
  day in airplane mode. That is the entire point of it.
- **It never redraws your screen.** Nothing shifts or jumps while you are at a
  counter mid-decision. What it downloads today is for the *next* time you open.
- **The stamp is only written once every file has actually landed.** Otherwise a
  single failed download would be recorded as "done" and never retried.

### The staleness reload — why the app sometimes refreshes itself

Here is the problem it solves.

The app works out today's date and which meal you are in **once, at boot** — and
then never looks at the clock again. There is no timer. And on iOS a Home Screen
app does not really close; it sits in memory for **days**.

```
   WITHOUT the guard:

   12:30   you open the app at lunch.  Meal = Lunch.   ok
   12:31   you switch to Messages. The app stays in memory.
   18:10   you come back at dinner.
           It is the same page from 12:30.
           Meal is STILL Lunch. You are reading the wrong menu.   wrong
```

So on every return to the app, it checks two things:

```
   you come back
        │
        ├─ page older than 2 hours?    ──►  full reload
        ├─ calendar date changed?      ──►  full reload
        └─ neither?                    ──►  leave it exactly as it was
```

- **Two hours** because that is roughly the gap between meals. Anything shorter
  is you putting your phone in your pocket partway through eating.
- **The date is checked separately** for one narrow case: you open at 11:50pm and
  come back at 12:10am. Under two hours, but a different day.
- **The reload is safe with no signal**, because it reloads out of Box 1 and
  Box 2. This would have been a disaster before the caches existed.

---

## The checks along the way

Data from a scraper is guilty until proven innocent. Five separate guards:

| Guard | Where | What it does |
|---|---|---|
| **Plausibility** | `quality.py` | Catches labels holding whole-batch totals — ROTI is published as 20,160 calories for "1 ea". Three rules: macros can't outweigh the serving, nothing beats 9 cal/g (pure fat), and an unweighed serving over 1,500 cal is suspect. **28 items flagged.** Flagged, never deleted — the item really is on the menu. |
| **Diet cross-check** | `diet.py` | Compares the classifier's answer against UMD's own icons and logs disagreements. **4 items end up with no diet level** — those are blocked at every level, never allowed to slip past a vegetarian filter. |
| **Per-item error isolation** | `scrape.py` | One unparseable label doesn't cost the run. Errors are collected and reported; the export publishes anyway. The job only *fails* if zero menu pages parsed. |
| **Missing means missing** | throughout | Any macro can be `null`, and `null` is not zero. It renders as an em dash, never sorts as zero, never passes a numeric filter. **12 items have no nutrition at all.** |
| **Nothing stated ≠ nothing present** | export | 1,009 items declare allergens; **552 declare none**, which means "UMD said nothing," not "it's clean." The filter is a preference tool, not allergy-safe, and the UI says so. |

Plus 122 pytest tests and 78 Node assertions, all running off saved fixtures and
the real export, never touching UMD's site.

---

## A typical Tuesday, in order

```
04:59 ET   nothing is running. There is no server. There never was.

05:00 ET   Action wakes. Fresh Ubuntu box.
           Restores umd.db + cache/ from the Actions cache.
           Fetches 21 menu pages (~11 s of polite waiting).
           Fetches maybe 5 new labels.
           Writes to SQLite. Prunes menu days older than 31 days.
           Exports 3 JSON shapes into docs/data.
           Deletes menu files for days that left the window.
           git commit + push.

05:01 ET   Pages redeploys. ~45 seconds.
           Tests workflow runs pytest in parallel.

05:11 ET   The 10-minute browser cache on Pages has expired.
           Your phone would now see the new files if it asked.

12:30 ET   You open the app at lunch.
           Everything renders instantly from cache — including the menu
           from BEFORE this morning's scrape.
           In the background, sync() fetches index.json, sees a new
           generated_at, and quietly pulls 163 KB. Screen doesn't move.

12:31 ET   You put your phone away.

18:10 ET   You open it at the dining hall.
           Page is >2 hours old, so it reloads — now off the cache that
           this afternoon's sync filled in. You get dinner, correctly,
           with no signal needed.
```

---

## Known fragile spots

1. **`umd.db` lives in an ephemeral Actions cache.** If it's evicted, history
   silently resets to 7 days. The whole date strip and saved-plates history hang
   on this. *Open question: is Sep 1 still in `index.json` after tomorrow's run?*
2. **Menu files list meals alphabetically**, `index.json` lists them
   chronologically. They disagree. The app works around it by always reading the
   index — but the exporter should make them agree at the source.
3. **Label pages are fetched once ever and never re-checked.** If UMD corrects a
   recipe's nutrition, we will never notice.
4. **`cache/` grows by ~1 GB a year and nothing prunes it.** Menu HTML is 859 KB
   a page, three new URLs appear every day, and they are never deleted. It shares
   the Actions cache with `umd.db`, so filling it up would take the database down
   too. The growing part is also the useless part — menu HTML is never read back.
5. **The 10-minute Pages cache** means a push is not visible on your phone for up
   to 10 minutes. Incognito bypasses it.

---

## Not built yet

**Dining hall hours** (step 2). They aren't on nutrition.umd.edu at all — that
site has zero time strings anywhere. They come from a public Google Sheet that
dining.umd.edu itself reads, with per-hall, per-meal, per-date hours a year out.
The plan is: fetch it during the scrape, store it in a small table, and write it
onto each day in `index.json`. About 1 KB, riding inside a file the app already
downloads and already caches offline.

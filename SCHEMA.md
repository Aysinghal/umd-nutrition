# Schema

Two separate places data lives:

- **Server side** — SQLite on my machine, exported to JSON. This is menu data. It's the
  same for everyone and nothing about it is personal.
- **Phone side** — browser local storage. Targets, favorites, hidden items, my ordering,
  and my current and recent plates. Never leaves the phone.

That split is why there's no login. There's nothing user-specific on the server to protect.

## SQLite tables

```sql
-- Nutrition label. Fetched once per ID, kept forever, never re-fetched.
CREATE TABLE items (
  rec_num_and_port       TEXT PRIMARY KEY,   -- "119370*1", full string incl. portion
  name                   TEXT NOT NULL,
  serving_size           TEXT,               -- raw: "1 ea", "4 oz"
  serving_qty            REAL,               -- parsed when possible, else NULL
  serving_unit           TEXT,
  servings_per_container REAL,
  -- Every macro is nullable. The site prints "- - -" for a nutrient it has no
  -- figure for, and that is stored as NULL. NULL is not 0: an item with unknown
  -- protein must not sort as a zero-protein item or slip through a max filter.
  calories               REAL,
  protein_g              REAL,
  total_fat_g            REAL,
  saturated_fat_g        REAL,
  trans_fat_g            REAL,
  cholesterol_mg         REAL,
  sodium_mg              REAL,
  carbs_g                REAL,
  fiber_g                REAL,
  sugars_g               REAL,
  added_sugars_g         REAL,
  ingredients            TEXT,               -- for the classifier, not displayed
  nutrition_available    INTEGER NOT NULL DEFAULT 1,  -- 0 = label has no data
  plausible              INTEGER NOT NULL DEFAULT 1,  -- 0 = numbers cannot be true
  implausible_reason     TEXT,               -- shown in the UI when plausible = 0
  allergens_text         TEXT,               -- the label's ALLERGENS: line
  label_fetched_at       TEXT,
  label_sha256           TEXT                -- ties row to cached raw HTML
);

-- Legend icons, normalised and split by kind. No foreign key to items on purpose:
-- tags come off the menu page, so they exist before the label is fetched and they
-- survive a label that fails to parse.
CREATE TABLE item_tags (
  rec_num_and_port TEXT NOT NULL,
  tag              TEXT NOT NULL,            -- 'dairy','vegan','pork','local'...
  kind             TEXT NOT NULL,            -- 'allergen' | 'diet' | 'sourcing'
  PRIMARY KEY (rec_num_and_port, tag)
);

-- Meat content worked out from the ingredient text at scrape time.
CREATE TABLE item_diet (
  rec_num_and_port   TEXT PRIMARY KEY REFERENCES items,
  has_beef           INTEGER NOT NULL DEFAULT 0,
  has_pork           INTEGER NOT NULL DEFAULT 0,
  has_poultry        INTEGER NOT NULL DEFAULT 0,
  has_fish           INTEGER NOT NULL DEFAULT 0,
  has_shellfish      INTEGER NOT NULL DEFAULT 0,
  diet_level         INTEGER,                -- lowest level that permits this item;
                                             -- NULL when unclassifiable
  source             TEXT NOT NULL,          -- 'classifier' | 'override'
  classifier_version INTEGER NOT NULL
);

-- My manual corrections. Survives re-running the classifier.
CREATE TABLE item_overrides (
  rec_num_and_port TEXT PRIMARY KEY REFERENCES items,
  diet_level       INTEGER NOT NULL,
  note             TEXT,
  set_at           TEXT NOT NULL
);

CREATE TABLE locations (location_num INTEGER PRIMARY KEY, name TEXT NOT NULL);
-- 16 South Campus, 19 Yahentamitsi, 51 251 North

CREATE TABLE menu_entries (
  id               INTEGER PRIMARY KEY,
  date             TEXT NOT NULL,            -- ISO yyyy-mm-dd
  location_num     INTEGER NOT NULL REFERENCES locations,
  meal             TEXT NOT NULL,            -- tab text: Breakfast/Lunch/Dinner/Brunch
  station          TEXT NOT NULL,            -- where to walk: "Purple Zone"
  rec_num_and_port TEXT NOT NULL REFERENCES items,
  UNIQUE (date, location_num, meal, station, rec_num_and_port)
);

-- Tells "no menu that day" apart from "never scraped that day".
CREATE TABLE menu_days (
  date         TEXT NOT NULL,
  location_num INTEGER NOT NULL,
  status       TEXT NOT NULL,                -- 'ok' | 'empty' | 'error'
  meals_found  TEXT,                         -- "Brunch,Dinner"
  item_count   INTEGER,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (date, location_num)
);

CREATE TABLE scrape_runs (
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT,
  pages_fetched INTEGER, cache_hits INTEGER, new_items INTEGER,
  errors INTEGER, ok INTEGER
);

CREATE INDEX idx_menu_lookup ON menu_entries(date, location_num, meal);
CREATE INDEX idx_menu_item   ON menu_entries(rec_num_and_port);
-- Standalone rather than external-content: keeping it in sync with `items` would
-- need triggers, and at a few thousand rows a copied name is cheaper than that.
CREATE VIRTUAL TABLE items_fts USING fts5(rec_num_and_port UNINDEXED, name);
```

## Diet levels

One integer per item: the lowest rung of the ladder that permits it.

| Level | Means | An item gets this level if |
|---|---|---|
| 1 | Vegetarian only | no meat of any kind |
| 2 | + chicken/turkey | contains poultry and nothing else |
| 3 | Any meat except beef | contains pork, fish, or shellfish |
| 4 | Anything | contains beef |

An item takes the highest level any of its meats demand — chicken *and* beef means level
4. So the whole diet filter is `WHERE diet_level <= :my_level`. One comparison.

`diet_level` is NULL when nothing can be concluded. NULL fails that comparison in SQL,
which is the behaviour we want: an unclassifiable item must never quietly pass a
vegetarian filter. 4 items out of 1,586 are in this state.

Eggs and dairy are fine at every level. Fish is not allowed at level 2; it first becomes
available at level 3.

**Three sources, because no one of them is enough.** The classifier reads the item name,
the ingredient text, and the site's own pork/fish/shellfish icons. Any of them finding a
meat is enough.

Ingredients alone are not sufficient: UMD sometimes omits the headline protein entirely.
"Escovitch Tilapia" lists oil, vinegar, onions and peppers and no fish at all. On
ingredients alone it classifies as vegetarian.

Rules that matter:

- **Strict.** Any mention of a meat counts. Chicken broth means chicken. Beef base means
  beef. No trace exceptions.
- **The site's vegan/vegetarian tag outranks a meat word in the name.** "Breaded Chicken
  Cutlet" is tagged vegan and really is plant protein. Only unnegated meat in the
  *ingredients* disputes the tag, and then the item goes to NULL for manual review
  rather than the classifier picking a winner.
- **The pork/fish/shellfish icons are authoritative.** If UMD says it contains fish, it
  contains fish, whatever the ingredient list leaves out.
- **Negation is checked.** A keyword is ignored if the 60 characters before it contain
  vegan, plant-based, imitation, mock, "free from", "without" and so on. This is what
  keeps "Vegan Beef Strip" at level 1 and stops a supplier's "Free from Crustaceans,
  Fish, Molluscs" from reading as fish.
- **"Turkey Bacon" is poultry.** A bird word before bacon/ham/sausage collapses to the
  bird before the pork keywords see it.
- **Overrides win over everything.** When I mark an item, that sticks, and
  `reclassify_all` preserves it.
- `classifier_version` gets bumped whenever the keyword rules change, so everything can be
  reclassified from stored ingredient text without re-scraping.

**Accuracy check, with a caveat.** Every disagreement with the site's pork/fish/shellfish
icons is logged. Building the icons into the classifier as an authoritative input does
weaken this as an independent test — it can now only catch the case where ingredients
name a meat the icon lacks, not the reverse. Beef and poultry have no icon at all, so
those two run entirely unchecked and are the ones worth spot-checking by hand.

Current state: 1,177 level 1, 169 level 2, 165 level 3, 71 level 4, 4 unknown, and zero
icon disagreements.

## Implausible rows

About 1% of labels hold whole-batch totals against a single-serving label. Three rules,
two of them physical limits rather than guesses:

1. **Mass** — protein + carbs + fat weighing more than the serving itself. Impossible.
2. **Energy density** — above 9.5 cal/g, when pure fat is 9. Impossible.
3. **Calorie ceiling** — over 1,500 cal for a serving given with no weight ("1 slice").
   The only judgement call of the three, since there is nothing to measure against.

29 items are flagged. They stay in the database and stay on the menu, hidden from
rankings by default with a toggle to show them, and always displayed with
`implausible_reason` so the number is never presented as trustworthy.

## What lives on the phone

Local storage, roughly:

- **Targets** — calories, protein, carbs, fat, fiber. Each has a number *and* an on/off
  flag, so some are tracked and some are only displayed. A stored default, overridable
  for a single meal.
- **Diet level** — which rung I'm on today.
- **Favorites, hidden items, custom ordering** — keyed by `rec_num_and_port`.
- **Plates** — current one plus roughly a month of past ones, each a date, hall, meal and
  a list of items with quantities.

Favorites can point at an item that has aged out of the export. The app should ignore a
dangling reference rather than break.

## JSON export

The phone app is static, so the scrape writes files it can fetch:

- `index.json` — halls, which dates are available, when it was generated, classifier
  version
- `items.json` — every item referenced in the retained window: id, name, serving size,
  macros, tags, allergens, diet level. **No ingredient text** — it is only classifier
  input, and leaving it out keeps the download small.
- `menu/<hall>-<date>.json` — that day's entries grouped by meal and station, referring to
  items by id

Split this way the browser caches `items.json` once and each day is a small fetch.

## Retention

- `items`, `item_tags`, `item_diet`, `item_overrides` — forever. Labels never change and
  re-fetching them is the expensive part.
- `menu_entries` and `menu_days` — one month, then pruned.
- Raw HTML cache on disk — kept forever, so parsers can be re-run or extended
  (micronutrients, ingredient display) without touching the network again.

## Things the site does that the schema has to survive

- **Weekends have different meals.** Saturday is Brunch + Dinner, two tabs, not three.
  `pane-2` is Lunch on a weekday and Dinner on a Saturday. Meal is always read from the
  tab text. That is why `meal` is free text and not a fixed set.
- **The same item shows up at several stations in one meal** — 87 cases in a single day at
  one hall. That is why `station` is part of the unique key.
- **Icons are stable per item.** Checked across 720 rows: no item ever had a different
  icon set or a different name in two places. That is why tags hang off the item and not
  off the menu entry.
- **The page never tells you what date it is.** The date dropdown comes back empty and
  nothing else on the page states the date, so there is no way to confirm the server gave
  you the day you asked for. The requested date is recorded as fact and cannot be verified.
- **A day with no menu is detectable**: about 14KB, no item links, no meal tabs at all.
  That is `status='empty'`, not an error.
- The "available during the school year" banner is on every page including full ones. It
  means nothing.
- **Phrases break across tags.** The flattened text reads "Trans
Fat 0g" and
  "Nutrition
Facts", so no anchor phrase can assume a literal space between its words.
- **"Total Carbohydrate." has a stray period** in the site's own markup.
- **"- - -" means no figure available**, and any label carrying one also gains a
  "Note: Nutritional Values that are not available..." line between the allergens and
  the closing disclaimer.
- **A manufacturer's ingredient text can contain the word "Allergens:".** One item's
  ingredients include a literal "Allergens: Wheat", so INGREDIENTS: and ALLERGENS: are
  matched case-sensitively and anchored to the start of a line. Matching them
  case-insensitively silently stores 400+ characters of ingredients as the allergen
  list -- wrong data, no error.
- **Some recipes have no label at all.** The page renders the name and "Nutritional
  Information is not available for this recipe." and nothing else. 13 of 1,586 items.
  Stored with `nutrition_available = 0` and every macro NULL. These have no ingredient
  text either, so they cannot be diet-classified and must never be assumed vegetarian.
- **A few rows hold whole-batch totals, not per-serving values.** ROTI is published as
  20,160 calories and 520 g protein for "1 ea", with "1 servings per container". This is
  UMD's own data-entry error, not a parsing bug -- the page really does say that. About
  11 items are wildly wrong (>1500 cal), 24 are questionable (>1000 cal), roughly 1% of
  the data. Any ranking or recommendation has to defend against these.
- **The same item can be a .gif on one page and a .png on another**: the shellfish
  legend icon is both, and is the only capitalised icon filename.

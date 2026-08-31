# UMD Dining Nutrition Tool — Goals

## What this is

A phone-friendly web page that shows what UMD's dining halls are serving today, with
the nutrition numbers attached, so I can decide what to eat and then log what I ate.

Data comes from scraping `nutrition.umd.edu` into a local SQLite database. The phone
app is a static page reading exported JSON — no server, no login.

## Why I want it

To eat properly at the dining hall. Right now the dining hall site tells me what's
being served but makes it slow to compare things, and nothing helps me pick based on
macros. I go about twice a day and want to use this at basically every meal.

This is for me, maybe a couple of friends. Not a product.

## The two things I do with it

**1. Before eating — what should I get?**

I'm standing in the dining hall. I pick which hall I'm at, and I want to quickly see
what's worth putting on my plate: ranked by macros, filtered to what I actually eat,
with the numbers visible. I add items to a plate as I go and watch the running total
against my targets.

I want a recommended list. I do not want it to build the meal for me — I pick.

**2. After eating — what did I eat?**

I log macros in FoodNoms. I need to quickly find the items I ate, add them to the
plate, and read off the totals. Searching has to be forgiving because I don't
remember exact menu names.

Both of these are the same screen. It's one plate that I add items to; before the
meal it's a plan, after the meal it's a record.

## What it needs to do

- Show today's menu for one hall, by meal, with macros and the station (which counter
  to walk to) on every item
- Rank and filter: min/max on calories and macros. Default sort is protein per calorie
- Filter by how I eat (see diet levels below)
- Forgiving search — partial names, rough guesses, misspellings
- A plate: add items, see running totals, compare against my targets
- Targets on calories, protein, carbs, fat and fiber. Each one can be switched on or
  off, so some are real targets and some are just numbers I can see. Stored defaults,
  overridable for a single meal
- A rendered Nutrition Facts label I can scan into FoodNoms — both per item and for
  the whole plate. Confirmed FoodNoms scans one off a screen.
- Favorites, hiding items I don't like, and saving my own ordering
- One month of menu history I can browse by date, plus my saved plates kept locally
  for a month, for when I forget to log a meal
- A "which hall should I go to tonight" comparison: applies my current filter and shows
  each hall's top few items side by side. I usually know where I'm going, so this is a
  nice-to-have and comes late

## Diet levels

I eat at different levels depending on the day. From most to least restrictive:

1. Vegetarian only
2. Vegetarian + chicken/turkey
3. Any meat except beef
4. Anything

The site's icons can't express this — there's no chicken or beef icon. So this has to
be worked out from each item's ingredient text, which does name the meat directly
("SLICED BEEF (Beef)", "Chicken Thigh Boneless Skinless"). Ingredients get stored and
classified during scraping.

The rule is strict: if a meat appears anywhere in the ingredients, the item counts as
containing that meat. Chicken broth means it has chicken. Beef base means it has beef.
There are no trace or incidental exceptions.

This means the site's vegetarian tag is not sufficient on its own. An item only counts
as vegetarian if the site tags it vegetarian *and* its ingredients show no meat. When
the tag and the ingredients disagree, the ingredients win.

The classifier will still get things wrong occasionally, usually by matching a meat word
that isn't meat. I need a way to correct an item permanently when I spot it.

## What it does not do

- It is not a macro tracker. FoodNoms does that. This just makes it fast to get the
  numbers into FoodNoms.
- No long-term record of what I ate. A month of saved plates is plenty.
- No accounts or login. Nothing user-specific is stored on the server side.
- No micronutrients or ingredient display for now. Ingredients are stored because the
  diet classifier needs them, not to be shown. Could add later.
- It doesn't pick my meal for me.

## Decisions already made

**Hosting: GitHub Pages, static, no server.** The scraper runs on a scheduled GitHub
Action and commits updated JSON. The phone app is a static page. Free, always available,
works on cellular with my laptop off. Personal settings live in phone local storage.
First load is about 63 KB gzipped; each extra day is about 1 KB.

**SQLite is the source of truth.** JSON export is a build step on top of it. The
scraper, database and CLI all still exist — the CLI is for running scrapes and
debugging, not for daily use.

**Labels are cached forever.** `RecNumAndPort` is a stable recipe ID, so once an
item's nutrition is fetched it never needs fetching again. Only new IDs get fetched
on a daily run.

**Politeness matters.** Descriptive user agent with a contact address, two requests
per second, single threaded, retries with backoff, raw HTML cached to disk so
re-parsing needs no network. The site publishes no robots.txt and so no crawl-delay;
2/sec single-threaded is less than one browser page load. Daily runs are tiny anyway
-- only a cold start or a backfill fetches in bulk.

## Known facts about the site

- Hall IDs: `16` South Campus, `19` Yahentamitsi, `51` 251 North
- One page has all three meals; tabs are Breakfast / Lunch / Dinner, read from the tab
  text rather than assumed by order
- `robots.txt` returns 404 — no crawl rules published
- The "nutrition info is available during the school year" banner is always present,
  even on days with a full menu. It is not an off-season signal. Off-season has to be
  detected by a page parsing to zero items.
- A single hall's single day has around 350 unique items. A cold scrape of three
  halls over seven days is about 1,600 label fetches, roughly 13 minutes at two per
  second. Measured, not estimated. After that daily runs are small.
- The legend has 16 icons mixing three different things: allergens (dairy, egg, fish,
  shellfish, gluten, soy, sesame, nuts, coconut, alcohol, pea protein), diet
  suitability (vegan, vegetarian, halal, pork), and sourcing (local). These should not
  all live in one undifferentiated tag blob. Note the shellfish icon is a .png while
  every other one is a .gif, and it is the only capitalised filename.

## Rough build order

1. Recon and fixtures — mostly done
2. Label parser with tests against saved HTML
3. Menu parser with tests against saved HTML
4. Database and scrape orchestration
5. Ingredient-based diet classifier
6. JSON export
7. The phone web page — this is the actual product
8. Scheduled daily scrape

## How solid this needs to be

Solid enough to rely on all semester. Parsers should fail loudly and name what they
couldn't find rather than quietly returning nothing. A menu page that parses to zero
items is an error worth surfacing. Every scrape logs a summary: pages fetched, cache
hits, new items, errors.

## Style

Small personal tool. No premature abstraction. Comments only where the site's weirdness
needs explaining. Ask before adding dependencies beyond requests, beautifulsoup4, lxml
and pytest.

# Front end plan

The spec the front end was built from. Decisions in GOALS.md still hold and aren't
repeated here.

**Stale after step 7** — steps 8-11 (offline, favourites/hiding, search, history and
saved plates) are built but not described here. See [TODO.md](TODO.md) for what's open
and [DATA-FLOW.md](DATA-FLOW.md) for how the data works.

## Shape of the app

One screen — a flat ranked list of food — with everything else layered over it as sheets.
Back always closes a sheet; nothing ever navigates away from the list.

```
┌──────────────────────────────────┐
│ Yahentamitsi ▾  Dinner ▾  Lvl 2 ▾│  header: hall, meal, diet level
├──────────────────────────────────┤
│ ★ Grilled Chicken Breast      +  │  favorites pinned above the ranked list
│   Broiler Works · 4 oz           │
│   180 cal  26.3 g P · 0.146 P/cal│
├──────────────────────────────────┤
│   Black Bean Burger           +  │  ranked by protein per calorie
│   Purple Zone · 1 ea             │
│   240 cal  18.0 g P · 0.075 P/cal│
│   … 3 hidden                     │
├──────────────────────────────────┤
│ 3 items                       ▲  │  plate bar, always visible
│ cal ████████░░░ 612/800          │
│ P   ██████████░  52/60           │
└──────────────────────────────────┘
      [ search ]        [ filters ]   thumb-height
```

**Sheets:** plate (expanded), item detail, filters, label, settings, history.

### Opening

Straight to the list. Hall is remembered from last time; meal is guessed from the clock
against the day's actual `meals` array, so weekends land on Brunch/Dinner without special
casing. A wrong guess costs one tap on the header chip.

## The list

**Rows.** Two lines plus badges: name (with ★ if favorited) and a `+` button; then
`station · serving`; then `cal / protein / protein-per-cal`. Allergen and diet badges only
when they're relevant to the current filters.

**Ranking.** Protein per calorie descending, with a minimum-protein floor (default 10 g)
so garnishes don't win. Items deduplicated across stations for ranking; the row shows the
station you'd walk to, and item detail lists all of them.

**Grouping toggle.** A switch flips the list to station-grouped (collapsible sections,
best item first inside each) for when you're walking the hall rather than choosing.
Flat is the default.

**Diet level.** A chip in the header. Tap cycles 1→2→3→4, long-press opens a picker.
Filter is `diet_level <= level`; `diet_level: null` never passes at any level and the
item detail says why.

**Filters sheet** (thumb-height button): protein floor, allergen exclusions, show/hide
flagged items, favorites-only, sort mode. Sort modes are protein-per-cal (default),
protein, calories, and my custom order.

**Favorites and hiding.** Star from item detail or long-press a row. Favorites that are
on tonight's menu pin to a short section above the ranked list. Hidden items disappear,
leaving a tappable "3 hidden" count. Custom ordering is a sort mode, never the default.

**Search.** Scoped to the current hall and meal. On no hits it offers one-tap widening to
all halls, then all dates — that's the path for logging a meal you forgot.

## The plate

**Adding.** The row's `+` adds one serving immediately with a brief undo. Tapping anywhere
else on the row opens item detail. Tapping `+` again on an item already on the plate makes
it ×2.

**Quantities.** Whole servings from the list. Inside the plate sheet each line has
`− ×n +` steppers and a `½` chip for the salad-bar case.

**Totals.** The collapsed plate bar shows item count plus calorie and protein bars.
Expanded, all five macros: enabled targets get a progress bar that changes color past
100%, disabled ones show as a bare number with no bar and no judgment.

**Targets.** Defaults live in the settings sheet — five rows, each a number field and an
on/off switch. Tapping a bar in the plate overrides that target for this meal only, shown
as `800 (default 700)` with a reset. The override dies with the plate.

**Clearing.** Never automatic. Switching hall, meal, or date with items on the plate — or
opening on a new day — offers *Save & start new plate*. Saved plates go to history. A
Clear button sits in the plate sheet.

## The FoodNoms label

A **Label** button on the plate and in item detail opens a full-screen sheet: black on
white, FDA-style, max brightness, nothing else on screen, swipe down to dismiss. Sized so
a phone camera can scan it.

The whole-plate label is named `Yahentamitsi Dinner — Aug 31` (editable before scanning),
serving size `1 plate`, servings per container `1`, so the whole meal imports as one entry.

## History

A date strip at the top of the list scrubs the menu across every date the export holds.
Saved plates from that date appear as cards you can reopen, re-label, or re-scan. Menus and
plates share one timeline, one picker.

## Bad and missing data

- **Null macros render as `—`, never `0`.** A null value never sorts as zero and never
  passes a numeric filter ("under 5 g fat" excludes unknown fat).
- **`no_data` (13 items)** — shown on the menu, "no nutrition info" in place of numbers,
  contributes nothing to plate totals.
- **`suspect` (29 items)** — hidden until you flip *show flagged items*. When shown: dimmed
  row, the reason string printed verbatim ("3503 calories for one 1 each"), and adding one
  to the plate takes a confirm.
- **`diet_level: null` (4 items)** — blocked at every level, with the reason visible.

## Offline

A service worker, cache-first. App shell and `items.json` cached on first visit; menu days
cached as you open them. Opens instantly with no signal and works fully on data you've
seen, revalidating in the background. When it serves stale content it says so quietly:
*data from Aug 31*.

## Data notes for whoever builds this

- `items.json` is a **flat object keyed by item id** — no wrapper key. `index.json` has the
  wrappers (`halls`, `dates`, `days`, `counts`).
- `days[].status` tells you whether a hall/date actually has a menu; don't assume the
  cartesian product of `halls × dates` exists.
- `meals` order in the menu file is meaningful. Never hardcode three meals.
- One item appears at several stations in one meal (87 cases in a single hall-day) — the
  same id, repeated across `stations[].items`.

## Tech stack

Plain HTML, CSS, and JS as ES modules. **No framework, no build step, no dependencies.**

- One screen doesn't need routing or a component tree.
- A build step is the real cost: it would put a compile between the daily scrape Action and
  a published site, so a broken build means no site. Today the deploy is "commit the files."
- ~330 rows per hall-meal renders fine with plain DOM. No virtualization needed.
- Zero dependencies means it still runs years from now without a maintenance pass.

The one discipline borrowed from frameworks: **a single `state` object and one `render()`**,
rather than patching the DOM from twenty event handlers. Events mutate state and call
render; render is a pure function of state. That's what keeps this from becoming spaghetti.

## Storing data without losing it

All personal state is in `localStorage`. It survives refreshes, closing the tab, restarts,
and OS updates. It can still be lost three ways:

1. **Clearing browser data** wipes it. Nothing client-side prevents this.
2. **iOS Safari evicts script-writable storage** for sites not interacted with for 7 days.
   Twice-daily use resets the timer, so this only bites over a long break.
3. **Storage pressure** — the OS reclaims space from non-persistent origins. Rare.

Three defenses:

- **Install to Home Screen.** Ship a web app manifest. On iOS a Home Screen web app gets a
  storage container exempt from the 7-day cap. It's also the right way to launch this:
  no browser chrome, one tap from the lock screen.
- **Call `navigator.storage.persist()`** on first run. Honored by Chrome and Firefox;
  Safari's support is inconsistent, so it's a bonus, not the plan.
- **Backup and restore.** The real insurance, and worth splitting by what actually hurts:

  | data | value | if lost |
  |---|---|---|
  | targets, favorites, hidden, custom order | high — accumulates over months | annoying to rebuild |
  | saved plates | low — FoodNoms is the record once scanned | lose the forgot-to-log net |

  So: a **Backup settings** button in the settings sheet that produces a file or a
  copyable blob, and an import to match. Recovery costs one paste, not a re-setup.

## Open

- **History depth.** This plan assumes a month; the export holds 7 days. That's an
  exporter change on the back end, to sequence before the history sheet is worth much.

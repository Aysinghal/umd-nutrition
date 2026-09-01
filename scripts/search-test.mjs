// Exercises docs/js/search.js against the real export, and prints how well plain
// substring matching actually does — which is the open question about this feature.
//
//   node scripts/search-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const { narrow, wide, NEXT_SCOPE } = await import('../docs/js/search.js');

const items = JSON.parse(readFileSync(join(DOCS, 'data/items.json'), 'utf8'));
const index = JSON.parse(readFileSync(join(DOCS, 'data/index.json'), 'utf8'));
const days = readdirSync(join(DOCS, 'data/menu')).map((f) => {
  const [hall, ...rest] = f.replace('.json', '').split('-');
  return { hall: Number(hall), date: rest.join('-'),
    menu: JSON.parse(readFileSync(join(DOCS, `data/menu/${f}`), 'utf8')) };
});

const TODAY = index.dates[0];
const yes = () => true;

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

// A day's worth of rows in the shape the list uses.
const meal = days.find((d) => d.hall === 19 && d.date === TODAY).menu.meals
  .find((m) => m.meal === 'Dinner');
const rowsById = new Map();
for (const st of meal.stations) {
  for (const id of st.items) if (items[id] && !rowsById.has(id)) rowsById.set(id, { id, item: items[id] });
}
const rows = [...rowsById.values()];

console.log(`\nnarrow, over ${rows.length} items at Yahentamitsi dinner`);
ok('an empty query changes nothing', narrow(rows, '').length === rows.length);
ok('whitespace counts as empty', narrow(rows, '   ').length === rows.length);
const chick = narrow(rows, 'chicken');
ok(`"chicken" matches ${chick.length}`, chick.length > 0 && chick.length < rows.length);
ok('every hit really contains it',
  chick.every((r) => r.item.name.toLowerCase().includes('chicken')));
ok('matching ignores case', narrow(rows, 'CHICKEN').length === chick.length);
ok('a query that matches nothing returns nothing', narrow(rows, 'zzzzq').length === 0);

console.log(`\nwide, over ${days.length} menu days`);
const w = wide(days, items, 'chicken', TODAY, yes);
ok(`"chicken" matches ${w.length} distinct items`, w.length > 0);
ok('one row per item id, never one per appearance',
  new Set(w.map((r) => r.id)).size === w.length);
ok('every hit carries hall, date and meal',
  w.every((r) => r.hall && r.date && r.meal));
ok('an empty query returns nothing at all', wide(days, items, '  ', TODAY, yes).length === 0);

const blocked = wide(days, items, 'chicken', TODAY, () => false);
ok('the filter predicate is obeyed', blocked.length === 0);

const noPork = wide(days, items, 'chicken', TODAY,
  (id, it) => !(it.allergens || []).includes('Pork'));
ok(`filtering out Pork drops ${w.length - noPork.length} of them`, noPork.length < w.length);

// Nearest-occurrence: run the same query anchored at each end of the week.
const first = wide(days, items, 'chicken', index.dates[0], yes);
const last = wide(days, items, 'chicken', index.dates[index.dates.length - 1], yes);
const moved = first.filter((r) => last.find((x) => x.id === r.id)?.date !== r.date);
ok(`anchoring at the far end of the week moves ${moved.length} results' shown date`,
  moved.length > 0);
ok('and the date shown is always one the item is actually served',
  first.every((r) => days.some(({ hall, date, menu }) => hall === r.hall && date === r.date
    && menu.meals.some((m) => m.meal === r.meal
      && m.stations.some((st) => st.items.includes(r.id))))));

ok('scopes widen meal -> halls -> dates, then stop',
  NEXT_SCOPE.meal === 'halls' && NEXT_SCOPE.halls === 'dates' && NEXT_SCOPE.dates === null);

console.log(`\n${pass} passed, ${fails.length} failed`);

// --- how good is substring matching, really -----------------------------------
console.log('\nsubstring matching on realistic queries (whole week, all halls):');
const total = Object.keys(items).length;
for (const q of ['chicken', 'tofu', 'egg', 'rice', 'salmon', 'quinoa',
                 'greens', 'veggie', 'vegetable', 'beans', 'protein', 'salad']) {
  const hits = wide(days, items, q, TODAY, yes);
  console.log(`  ${(q + ':').padEnd(12)} ${String(hits.length).padStart(4)} of ${total}`
    + (hits.length ? `   e.g. ${hits.slice(0, 2).map((r) => r.item.name).join(' / ')}` : ''));
}

if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

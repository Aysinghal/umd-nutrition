// Exercises mealHours() in docs/js/data.js, the reader behind the hours shown on
// the meal and hall sheets. Runs against hand-built index shapes and against the
// real docs/data/index.json, so it stays honest about what is actually published.
//
//   node scripts/hours-test.mjs

import { readFileSync } from 'node:fs';

const { mealHours } = await import('../docs/js/data.js');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

const SOUTH = 16, NORTH_251 = 51;
const TUE = '2026-09-01', SAT = '2026-09-05';

// The shape the exporter writes, taken from a real dry run against the live sheet.
const index = {
  days: [
    { date: TUE, hall: SOUTH, meals: ['Breakfast', 'Lunch', 'Dinner'],
      hours: { Breakfast: '7am-10:30am', Lunch: '10:30am-4pm', Dinner: '4pm-9pm' } },
    { date: TUE, hall: NORTH_251, meals: ['Breakfast', 'Lunch', 'Dinner'],
      hours: { Breakfast: '8am-10:30am', Lunch: '10:30am-4pm', Dinner: '4pm-10pm' } },
    { date: SAT, hall: SOUTH, meals: ['Brunch', 'Dinner'],
      hours: { Brunch: '10am-4pm', Dinner: '4pm-9pm' } },
    { date: SAT, hall: NORTH_251, meals: ['Breakfast', 'Lunch', 'Dinner'],
      hours: { Breakfast: '8am-10:30am', Lunch: '10:30am-4pm', Dinner: '4pm-7pm' } },
  ],
};

console.log('\nreading the published shape:');

ok('a weekday breakfast', mealHours(index, SOUTH, TUE, 'Breakfast') === '7am – 10:30am',
  `got ${mealHours(index, SOUTH, TUE, 'Breakfast')}`);

ok('the dash is spaced, the times are left as UMD wrote them',
  mealHours(index, SOUTH, TUE, 'Lunch') === '10:30am – 4pm');

ok('halls genuinely differ, which is the whole point',
  mealHours(index, SOUTH, TUE, 'Dinner') === '4pm – 9pm'
  && mealHours(index, NORTH_251, TUE, 'Dinner') === '4pm – 10pm');

ok('weekends genuinely differ too',
  mealHours(index, NORTH_251, TUE, 'Dinner') === '4pm – 10pm'
  && mealHours(index, NORTH_251, SAT, 'Dinner') === '4pm – 7pm');

ok('a derived weekend brunch reads as one service',
  mealHours(index, SOUTH, SAT, 'Brunch') === '10am – 4pm');

ok('only the separator is touched, never a time',
  mealHours({ days: [{ date: TUE, hall: SOUTH, hours: { Dinner: '4pm-9pm-ish' } }] },
    SOUTH, TUE, 'Dinner') === '4pm – 9pm-ish');

console.log('\nmissing is missing, and never "closed":');

ok('a meal this hall does not serve that day', mealHours(index, SOUTH, SAT, 'Lunch') === null);
ok('a day with no hours key at all',
  mealHours({ days: [{ date: TUE, hall: SOUTH, meals: ['Dinner'] }] }, SOUTH, TUE, 'Dinner') === null);
ok('an empty hours object', mealHours({ days: [{ date: TUE, hall: SOUTH, hours: {} }] }, SOUTH, TUE, 'Dinner') === null);
ok('a hall that is not in the index', mealHours(index, 999, TUE, 'Dinner') === null);
ok('a date that is not in the index', mealHours(index, SOUTH, '2020-01-01', 'Dinner') === null);
ok('an empty index', mealHours({ days: [] }, SOUTH, TUE, 'Dinner') === null);

console.log('\nclosed is a real answer, and survives verbatim:');

const closed = { days: [{ date: TUE, hall: SOUTH, hours: { Dinner: 'Closed' } }] };
ok('"Closed" is passed through, not formatted', mealHours(closed, SOUTH, TUE, 'Dinner') === 'Closed');
ok('and it is distinguishable from "we do not know"',
  mealHours(closed, SOUTH, TUE, 'Dinner') !== null && mealHours(closed, SOUTH, TUE, 'Lunch') === null);

console.log('\nagainst the real docs/data/index.json:');

const real = JSON.parse(readFileSync(new URL('../docs/data/index.json', import.meta.url), 'utf8'));
const withHours = real.days.filter((d) => d.hours);
const pairs = real.days.flatMap((d) => (d.meals || []).map((m) => [d, m]));

// Derived from the export, never hardcoded: the daily scrape changes these.
console.log(`  (${real.days.length} hall-days, ${pairs.length} hall-day-meals, `
  + `${withHours.length} with hours)`);

ok('every hall-day-meal in the export resolves without throwing',
  pairs.every(([d, m]) => {
    const v = mealHours(real, d.hall, d.date, m);
    return v === null || typeof v === 'string';
  }));

if (withHours.length === 0) {
  // True until the next Action run publishes them. The app must stay silent, not
  // guess, and this is the state a phone with an older cached export sees too.
  ok('no hours published yet, so nothing is invented',
    pairs.every(([d, m]) => mealHours(real, d.hall, d.date, m) === null));
} else {
  ok('published hours are strings with a spaced dash or "Closed"',
    withHours.every((d) => Object.keys(d.hours).every((m) => {
      const v = mealHours(real, d.hall, d.date, m);
      return v === 'Closed' || (typeof v === 'string' && v.includes(' – '));
    })));
  ok('hours are only published for meals the day actually serves',
    withHours.every((d) => Object.keys(d.hours).every((m) => d.meals.includes(m))));
}

console.log('\nwhat goes into the sheet is escaped:');

const { esc } = await import('../docs/js/util.js');
ok('a spreadsheet cell cannot inject markup',
  esc('4pm-9pm<img src=x onerror=alert(1)>') === '4pm-9pm&lt;img src=x onerror=alert(1)&gt;');
ok('quotes are escaped, so a note cannot break out of an attribute',
  esc('a"b') === 'a&quot;b');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

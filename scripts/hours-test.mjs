// Exercises mealHours() in docs/js/data.js, the reader behind the hours shown on
// the meal and hall sheets. Runs against hand-built index shapes and against the
// real docs/data/index.json, so it stays honest about what is actually published.
//
//   node scripts/hours-test.mjs

import { readFileSync } from 'node:fs';

const { mealHours, hallDayHours } = await import('../docs/js/data.js');

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

console.log('\nthe hall list: open to close, one line per hall:');

const dayLine = (hours) => hallDayHours({ days: [{ date: TUE, hall: SOUTH, hours }] }, SOUTH, TUE);

ok('a term weekday collapses to a single range',
  dayLine({ Breakfast: '7am-10:30am', Lunch: '10:30am-4pm', Dinner: '4pm-9pm' }) === '7am – 9pm',
  `got ${dayLine({ Breakfast: '7am-10:30am', Lunch: '10:30am-4pm', Dinner: '4pm-9pm' })}`);

ok('a brunch hall collapses the same way',
  dayLine({ Brunch: '10am-4pm', Dinner: '4pm-9pm' }) === '10am – 9pm');

// The whole reason for the change: on a Saturday one hall serves Brunch and the
// next serves Lunch, and both still get a line.
ok('a lunch hall on a brunch day still gets a line',
  dayLine({ Breakfast: '8am-10:30am', Lunch: '10:30am-4pm', Dinner: '4pm-7pm' }) === '8am – 7pm');

ok('a summer gap is kept, not papered over',
  dayLine({ Breakfast: 'Closed', Lunch: '11am-1:30pm', Dinner: '5:30pm-6:30pm' })
    === '11am – 1:30pm, 5:30pm – 6:30pm');

ok('windows out of order still sort',
  dayLine({ Dinner: '4pm-9pm', Breakfast: '7am-10:30am', Lunch: '10:30am-4pm' }) === '7am – 9pm');

// Breakfast and dinner with no lunch between them is a genuine hole in the day,
// not a formatting quirk, so it prints as two windows.
ok('a missing middle meal reads as a gap',
  dayLine({ Breakfast: '7am-10:30am', Dinner: '4pm-9pm' }) === '7am – 10:30am, 4pm – 9pm');

ok('overlapping windows merge rather than repeat',
  dayLine({ a: '11am-2pm', b: '1pm-4pm' }) === '11am – 4pm');

ok('midnight is read as 12am, not noon',
  dayLine({ Breakfast: '12am-3am', Dinner: '12pm-9pm' }) === '12am – 3am, 12pm – 9pm');

ok('a fully closed hall says so', dayLine({ Breakfast: 'Closed', Dinner: 'Closed' }) === 'Closed');

// UMD publishes TBD on dates it has not settled: 1,086 such cells across a year.
ok('TBD is not a time and is never shown', dayLine({ Breakfast: 'TBD', Lunch: 'TBD' }) === null);
ok('TBD alongside Closed still reads as closed',
  dayLine({ Breakfast: 'TBD', Dinner: 'Closed' }) === 'Closed');
ok('TBD alongside a real window shows only the window',
  dayLine({ Breakfast: 'TBD', Dinner: '4pm-9pm' }) === '4pm – 9pm');

ok('no hours key at all', hallDayHours({ days: [{ date: TUE, hall: SOUTH }] }, SOUTH, TUE) === null);
ok('an unknown hall or date',
  hallDayHours(index, 999, TUE) === null && hallDayHours(index, SOUTH, '2020-01-01') === null);

console.log('\n  every hall-day in the real export:');

const lines = real.days.map((d) => [d, hallDayHours(real, d.hall, d.date)]);
const blank = lines.filter(([, v]) => v === null);
console.log(`  (${lines.length} hall-days, ${blank.length} with no line`
  + `${blank.length ? ' -- ' + [...new Set(blank.map(([d]) => d.date))].join(', ') : ''})`);

ok('nothing malformed comes out of the real export',
  lines.every(([, v]) => v === null || v === 'Closed' || /^\d/.test(v)));

ok('every published day with hours produces a line',
  real.days.filter((d) => d.hours).every((d) => hallDayHours(real, d.hall, d.date) !== null));

console.log('\nwhat goes into the sheet is escaped:');

const { esc } = await import('../docs/js/util.js');
ok('a spreadsheet cell cannot inject markup',
  esc('4pm-9pm<img src=x onerror=alert(1)>') === '4pm-9pm&lt;img src=x onerror=alert(1)&gt;');
ok('quotes are escaped, so a note cannot break out of an attribute',
  esc('a"b') === 'a&quot;b');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

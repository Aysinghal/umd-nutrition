// Exercises docs/js/history.js through the real store. The claim worth proving is that
// a saved plate is frozen: neither an item leaving the export nor an override you make
// later can change what it says you ate.
//
//   node scripts/history-test.mjs

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const history = await import('../docs/js/history.js');
const plate = await import('../docs/js/plate.js');
const store = await import('../docs/js/store.js');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

const mkPlate = (over = {}) => ({
  name: 'Yahentamitsi dinner', hall: 19, date: '2026-09-01', meal: 'Dinner',
  sums: { cal: 812, protein: 61.4, carbs: 70, fat: 24 },
  unknown: { cal: 0, fiber: 2 },
  items: [{ id: '060022*1', qty: 1, name: 'Jerk Chicken' }],
  ...over,
});

console.log('\nsaving and reading back');
const a = history.save(mkPlate());
ok('save returns a record with an id and a timestamp', !!a.id && !!a.at);
ok('it comes back in the list', history.list().length === 1);
ok('and by id', history.get(a.id)?.name === 'Yahentamitsi dinner');
ok('found by its date', history.forDate('2026-09-01').length === 1);
ok('not found on another date', history.forDate('2026-09-02').length === 0);
ok('datesWithPlates marks the day', history.datesWithPlates().has('2026-09-01'));

console.log('\nfrozen numbers');
const before = JSON.stringify(history.get(a.id).sums);
// Whatever happens to items.json or to your overrides, the saved copy holds its own
// numbers and never consults them again.
ok('the saved plate carries its own sums', history.get(a.id).sums.cal === 812);
ok('and its own item names', history.get(a.id).items[0].name === 'Jerk Chicken');
ok('re-reading does not recompute anything', JSON.stringify(history.get(a.id).sums) === before);
ok('unknown counts survive, so "at least" still reads right',
  history.get(a.id).unknown.fiber === 2);

console.log('\nrename and delete');
history.rename(a.id, 'Tuesday dinner');
ok('rename sticks', history.get(a.id).name === 'Tuesday dinner');
ok('rename leaves the numbers alone', history.get(a.id).sums.cal === 812);
const b = history.save(mkPlate({ date: '2026-09-02' }));
ok('newest first', history.list()[0].id === b.id);
history.remove(a.id);
ok('delete removes only that one', history.list().length === 1 && history.get(a.id) === null);

console.log('\nexpiry at 31 days');
const day = 86400000;
// Through the store, not straight into localStorage: store.js holds the object in
// memory and only writes through, so a behind-its-back edit would be ignored.
const stamp = (id, daysAgo) => {
  store.set('plates', store.get('plates').map((p) =>
    (p.id === id ? { ...p, at: new Date(Date.now() - daysAgo * day).toISOString() } : p)));
};
const burst = Array.from({ length: 50 }, (_, i) => history.save(mkPlate({ name: `burst ${i}` })));
ok('50 plates saved in a burst all get distinct ids',
  new Set(burst.map((p) => p.id)).size === 50);
for (const p of burst) history.remove(p.id);
ok('and each can be deleted individually', history.list().length === 1);

const old30 = history.save(mkPlate({ name: '30 days old' }));
const old32 = history.save(mkPlate({ name: '32 days old' }));
stamp(old30.id, 30);
stamp(old32.id, 32);
const live = history.list();
ok('a 30-day-old plate survives', live.some((p) => p.name === '30 days old'));
ok('a 32-day-old plate is gone', !live.some((p) => p.name === '32 days old'));
ok('expiry is written back, not recomputed each read',
  JSON.parse(mem.get('umd-nutrition')).plates.every((p) => p.name !== '32 days old'));

console.log('\nthe totals bug this exists to avoid');
// plate.totals() skips ids it cannot find, so a live recompute of an aged-out plate
// silently under-reports. This is the failure a frozen plate is immune to.
const items = { '060022*1': { cal: 400, protein: 30 } };
plate.clear();
plate.add('060022*1', 1);
plate.add('gone-from-export', 1);
const { sums } = plate.totals(items, ['cal', 'protein']);
ok(`live recompute of a plate with a missing item reports ${sums.cal}, not the real total`,
  sums.cal === 400);
ok('while the frozen plate still reports what it was saved with',
  history.list().find((p) => p.name === '30 days old').sums.cal === 812);

console.log('\nbackup carries plates');
ok('plates live in the one backed-up object', 'plates' in JSON.parse(mem.get('umd-nutrition')));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

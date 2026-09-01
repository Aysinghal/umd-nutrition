// Exercises docs/js/marks.js for real, through docs/js/store.js, against a stubbed
// localStorage. Starring and hiding mean opposite things, so the thing worth proving
// is that an item can never end up in both lists.
//
//   node scripts/marks-test.mjs

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// Imported after the stub exists: store.js reads localStorage at module load.
const marks = await import('../docs/js/marks.js');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
};
const saved = () => JSON.parse(mem.get('umd-nutrition') || '{}');

const A = '060022*1';
const B = '060062*2';

ok('nothing is starred or hidden to begin with', !marks.isFav(A) && !marks.isHidden(A));

ok('starring returns true and sticks', marks.toggleFav(A) === true && marks.isFav(A));
ok('starring writes through to storage', (saved().favorites || []).includes(A));

ok('starring again un-stars', marks.toggleFav(A) === false && !marks.isFav(A));

marks.toggleFav(A);
marks.toggleHidden(A);
ok('hiding a starred item un-stars it', marks.isHidden(A) && !marks.isFav(A));
ok('and storage agrees', (saved().hidden || []).includes(A) && !(saved().favorites || []).includes(A));

marks.toggleFav(A);
ok('starring a hidden item un-hides it', marks.isFav(A) && !marks.isHidden(A));

marks.toggleHidden(B);
ok('the two lists are independent per item', marks.isFav(A) && marks.isHidden(B));
ok('hiddenCount counts hidden only', marks.hiddenCount() === 1, `got ${marks.hiddenCount()}`);

marks.unhide(B);
ok('unhide clears it', !marks.isHidden(B) && marks.hiddenCount() === 0);
ok('unhiding something not hidden is a no-op', (marks.unhide('nope'), marks.hiddenCount() === 0));

// The backup exports the whole settings object, so new keys ride along for free.
ok('both keys live in the one backed-up object',
  'favorites' in saved() && 'hidden' in saved());

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

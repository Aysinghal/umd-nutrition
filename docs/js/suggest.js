// Suggests numbers for the 13 items the menu publishes with no nutrition at all, by
// finding the closest-named item that does have figures.
//
// It is right about eight times in thirteen and wrong the rest, always low —
// "Corn Nuts" matches plain "Corn", "Mixed Baby Peppers" matches "Baby Corn". So the
// source item is shown next to the numbers: seeing "from Baby Corn" is what makes a
// bad guess obvious. Never accept one of these silently.

const STOP = new Set(['the', 'and', 'with', 'of', 'a', 'in', 'on',
  'side', 'fresh', 'house', 'style', 'assorted', 'mixed']);

const stem = (w) => w.replace(/ies$/, 'y').replace(/s$/, '');

const tokens = (name) =>
  name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);

export const FIELDS = ['cal', 'protein', 'carbs', 'fat'];

export function buildIndex(items) {
  const pool = Object.values(items).filter((v) => !v.no_data && v.cal != null && !v.suspect);

  // Rare words should count for more: "chocolate" is a better signal than "grilled".
  const df = new Map();
  for (const v of pool) for (const w of new Set(tokens(v.name))) df.set(w, (df.get(w) || 0) + 1);

  return {
    pool,
    idf: (w) => Math.log(pool.length / ((df.get(w) || 0) + 1)),
  };
}

// Returns { from, values } or null.
export function suggestFor(item, index) {
  const want = new Set(tokens(item.name));
  if (!want.size) return null;

  let best = null;
  for (const v of index.pool) {
    const have = new Set(tokens(v.name));
    let score = 0;
    for (const w of want) if (have.has(w)) score += index.idf(w);
    if (!score) continue;
    // Divide by length so a short, precise name beats a long one that happens to
    // contain the same word.
    score /= Math.sqrt(have.size || 1);
    if (!best || score > best.score) best = { score, v };
  }
  if (!best) return null;

  return {
    from: best.v,
    values: Object.fromEntries(FIELDS.map((f) => [f, best.v[f] ?? 0])),
  };
}

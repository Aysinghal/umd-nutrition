// Fetching and joining the three exported JSON files. Nothing here knows about the UI.

const BASE = 'data';

async function json(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// The index is loaded once at boot. Remembering it here means a sheet can ask how
// old the data is without the answer being threaded through the whole UI.
let lastIndex = null;

export const loadIndex = async () => { lastIndex = await json('index.json'); return lastIndex; };
export const loadItems = () => json('items.json');

// Whole days between the export and today. Offline, the app keeps serving the last
// export it managed to download, so this is the only honest freshness signal there is.
export function dataAgeDays() {
  if (!lastIndex) return null;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(new Date()) - midnight(new Date(lastIndex.generated_at))) / 86400000);
}

// Switching back and forth between halls shouldn't refetch. Menu days are ~8 KB and
// there are at most 21 of them.
const menus = new Map();

export function loadMenu(hall, date) {
  const key = `${hall}-${date}`;
  if (!menus.has(key)) menus.set(key, json(`menu/${key}.json`));
  return menus.get(key);
}

// A day that fails to load shouldn't take a whole search down with it, so failures are
// dropped rather than rejected.
export async function loadMenus(days) {
  const out = await Promise.allSettled(days.map(async (d) => ({
    hall: d.hall, date: d.date, menu: await loadMenu(d.hall, d.date),
  })));
  return out.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// The menu file lists meals alphabetically; index.json lists them in the order they
// actually happen. Always ask the index.
export function mealsFor(index, hall, date) {
  const day = index.days.find((d) => d.hall === hall && d.date === date);
  return day ? day.meals : [];
}

export function hasDay(index, hall, date) {
  return index.days.some((d) => d.hall === hall && d.date === date && d.status === 'ok');
}

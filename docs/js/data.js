// Fetching and joining the three exported JSON files. Nothing here knows about the UI.

const BASE = 'data';

async function json(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export const loadIndex = () => json('index.json');
export const loadItems = () => json('items.json');
export const loadMenu = (hall, date) => json(`menu/${hall}-${date}.json`);

// The menu file lists meals alphabetically; index.json lists them in the order they
// actually happen. Always ask the index.
export function mealsFor(index, hall, date) {
  const day = index.days.find((d) => d.hall === hall && d.date === date);
  return day ? day.meals : [];
}

export function hasDay(index, hall, date) {
  return index.days.some((d) => d.hall === hall && d.date === date && d.status === 'ok');
}

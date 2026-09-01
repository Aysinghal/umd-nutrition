// Starred and hidden items. Ids only — the nutrition still comes from items.json, so a
// star costs nothing and survives the numbers changing under it.
//
// An item is starred, hidden, or neither. Never both: they mean opposite things, and
// letting them overlap would only create a state with no sensible way to render it.

import * as store from './store.js';

const list = (key) => store.get(key) || [];

export const isFav = (id) => list('favorites').includes(id);
export const isHidden = (id) => list('hidden').includes(id);
export const hiddenCount = () => list('hidden').length;

function toggle(key, other, id) {
  const cur = list(key);
  const on = !cur.includes(id);
  store.set(key, on ? [...cur, id] : cur.filter((x) => x !== id));
  if (on) store.set(other, list(other).filter((x) => x !== id));
  return on;
}

export const toggleFav = (id) => toggle('favorites', 'hidden', id);
export const toggleHidden = (id) => toggle('hidden', 'favorites', id);

export function unhide(id) {
  store.set('hidden', list('hidden').filter((x) => x !== id));
}

// What the list shows and in what order. Persisted like the hall and diet level.
// The sheet that edits these lives in settings.js, since they are all settings.

import * as store from './store.js';

export const SORTS = {
  ratio: 'Protein per cal',
  protein: 'Most protein',
  cal: 'Fewest calories',
};

// Count is how many items declare it, so a toggle's cost is visible before you flip it.
export const ALLERGENS = [
  ['Gluten', 551], ['Dairy', 489], ['Soybeans', 360], ['Eggs', 320],
  ['Pea Protein', 153], ['Sesame', 125], ['Pork', 114], ['Alcohol', 90],
  ['Coconut', 68], ['Fish', 62], ['Tree Nuts', 29],
  ['Crustacean Shellfish', 29], ['Peanuts', 28],
];

export const get = () => ({
  sort: store.get('sort'),
  floor: store.get('floor'),
  avoid: store.get('avoid') || [],
  showFlagged: store.get('showFlagged'),
});

const DEFAULTS = { sort: 'ratio', floor: 10, avoid: [], showFlagged: false };

export function reset() {
  for (const [k, v] of Object.entries(DEFAULTS)) store.set(k, v);
}

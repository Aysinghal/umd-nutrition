// What the list shows and in what order. Persisted like the hall and diet level.

import { panel } from './sheet.js';
import { openKeypad } from './keypad.js';
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

export function openFilters(onChange) {
  const draw = () => {
    const f = get();
    const html = `
      <p class="f-head">Sort by</p>
      <div class="f-chips">
        ${Object.entries(SORTS).map(([k, label]) =>
          `<button class="f-chip${f.sort === k ? ' on' : ''}" data-sort="${k}">${label}</button>`).join('')}
      </div>

      <button class="fill-row" data-floor>
        <span>Minimum protein<span class="d-was">ranks below this, never hidden</span></span>
        <span class="fill-v">${f.floor} g</span>
      </button>

      <p class="f-head">Avoid</p>
      <div class="f-chips">
        ${ALLERGENS.map(([name, n]) =>
          `<button class="f-chip${f.avoid.includes(name) ? ' on' : ''}" data-avoid="${name}">${name}
            <span class="f-n">${n}</span></button>`).join('')}
      </div>
      <p class="f-note">Hides items that declare it. Not reliable for a real allergy.</p>

      <button class="fill-row f-toggle${f.showFlagged ? ' on' : ''}" data-flagged
        aria-pressed="${f.showFlagged}">
        <span>Show flagged items<span class="d-was">29 items whose numbers can't be true</span></span>
        <span class="sw" aria-hidden="true"><span class="knob"></span></span>
      </button>

      <div class="panel-actions"><button class="danger" data-reset>Reset all filters</button></div>`;
    return html;
  };

  const update = panel({
    title: 'Filters',
    html: draw(),
    onClick: (e) => {
      const sort = e.target.closest('[data-sort]');
      const avoid = e.target.closest('[data-avoid]');

      if (sort) store.set('sort', sort.dataset.sort);
      else if (avoid) {
        const name = avoid.dataset.avoid;
        const list = store.get('avoid') || [];
        store.set('avoid', list.includes(name) ? list.filter((a) => a !== name) : [...list, name]);
      } else if (e.target.closest('[data-flagged]')) store.set('showFlagged', !store.get('showFlagged'));
      else if (e.target.closest('[data-reset]')) reset();
      else if (e.target.closest('[data-floor]')) {
        return openKeypad({
          title: 'Minimum protein',
          subtitle: 'items below this rank under the divider',
          initial: store.get('floor'),
          onDone: (v) => { store.set('floor', v); onChange(); openFilters(onChange); },
        });
      } else return;

      onChange();
      update(draw());
    },
  });
}

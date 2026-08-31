// Numbers you supplied yourself, replacing or filling in what the menu published.
//
// Every item can be overridden. What differs is how loudly the app asks: an item with
// no numbers at all gets a prominent invitation, an item whose numbers are impossible
// gets one too, and an ordinary item just gets a quiet edit button behind a confirm.

import * as store from './store.js';

export const FIELDS = ['cal', 'protein', 'carbs', 'fat'];

// Only ever describes numbers YOU supplied. The menu's own figures always come from
// UMD's site — that isn't a choice, so it isn't in here.
export const SOURCES = {
  estimate: { label: 'My estimate', short: 'estimated' },
  package: { label: 'Package label', short: 'from package' },
  lookup: { label: 'Looked it up', short: 'looked up' },
};

function load() {
  const saved = store.get('overrides');
  if (saved && Object.keys(saved).length) return saved;

  // Earlier builds stored bare {cal,protein,...} under `estimates`.
  const legacy = store.get('estimates') || {};
  const migrated = {};
  for (const [id, values] of Object.entries(legacy)) {
    migrated[id] = { values, source: 'estimate', basis: null, at: null };
  }
  if (Object.keys(migrated).length) store.set('overrides', migrated);
  return migrated;
}

let data = load();

export const all = () => data;
export const get = (id) => data[id] || null;

export function set(id, { values, source, basis }) {
  data = { ...data, [id]: { values, source, basis: basis ?? null, at: new Date().toISOString() } };
  store.set('overrides', data);
}

export function remove(id) {
  data = { ...data };
  delete data[id];
  store.set('overrides', data);
}

// Folds overrides into the loaded items, so everything downstream — ranking, plate
// totals, labels — sees one consistent set of numbers.
export function applyTo(items) {
  for (const [id, entry] of Object.entries(data)) {
    const item = items[id];
    if (!item) continue;
    if (!item._published) {
      item._published = Object.fromEntries(FIELDS.map((f) => [f, item[f]]));
      item._wasNoData = !!item.no_data;
    }
    Object.assign(item, entry.values, { no_data: false, override: entry.source });
  }
}

// Puts an item back the way the menu published it.
export function revert(items, id) {
  const item = items[id];
  if (item?._published) {
    Object.assign(item, item._published, { no_data: item._wasNoData });
    delete item.override;
  }
  remove(id);
}

// What's on the plate right now. Knows nothing about the DOM.

import * as store from './store.js';

export const MACROS = ['cal', 'protein', 'carbs', 'fat', 'fiber'];

// Everything a Nutrition Facts panel prints, in label order.
export const LABEL_FIELDS = ['cal', 'fat', 'sat_fat', 'trans_fat', 'chol', 'sodium',
  'carbs', 'fiber', 'sugar', 'added_sugar', 'protein'];

export const LABELS = {
  cal: 'cal', protein: 'protein', carbs: 'carbs', fat: 'fat', fiber: 'fiber',
};

export const UNITS = { cal: '', protein: 'g', carbs: 'g', fat: 'g', fiber: 'g' };

// Per meal, not per day — a plate is one meal. `on` is the difference between a
// target you're measured against and a number you just want to see.
const DEFAULT_TARGETS = {
  cal: { value: 800, on: true },
  protein: { value: 60, on: true },
  carbs: { value: 90, on: false },
  fat: { value: 25, on: false },
  fiber: { value: 10, on: false },
};

// `temp` holds this-meal-only overrides, which never touch what's stored.
export function targets(temp) {
  const saved = store.get('targets') || {};
  return Object.fromEntries(MACROS.map((m) => {
    const base = { ...DEFAULT_TARGETS[m], ...(saved[m] || {}) };
    const overridden = temp && temp[m] != null;
    return [m, {
      value: overridden ? temp[m] : base.value,
      on: base.on,
      def: base.value,
      temp: overridden,
    }];
  }));
}

export function setTarget(macro, patch) {
  const saved = { ...(store.get('targets') || {}) };
  saved[macro] = { ...DEFAULT_TARGETS[macro], ...(saved[macro] || {}), ...patch };
  store.set('targets', saved);
}

let entries = store.get('plate') || [];

const save = () => store.set('plate', entries);

export const list = () => entries;
export const isEmpty = () => entries.length === 0;
export const servings = () => entries.reduce((n, e) => n + e.qty, 0);
export const qtyOf = (id) => entries.find((e) => e.id === id)?.qty ?? 0;

// Two decimals, so a typed 1/3 survives as 0.33 instead of rounding to a half.
const round2 = (n) => Math.round(n * 100) / 100;

export function add(id, step = 1) {
  const found = entries.find((e) => e.id === id);
  if (found) found.qty = round2(found.qty + step);
  else entries.push({ id, qty: step });
  save();
}

export function setQty(id, qty) {
  const q = round2(qty);
  if (q <= 0) entries = entries.filter((e) => e.id !== id);
  else {
    const found = entries.find((e) => e.id === id);
    if (found) found.qty = q;
  }
  save();
}

export function remove(id) {
  entries = entries.filter((e) => e.id !== id);
  save();
}

export function clear() {
  entries = [];
  save();
}

// Sums every macro, and separately records which items had nothing to contribute.
// A null is not a zero: if anything is unknown the total is a floor, not an answer,
// and the UI has to say so rather than quietly under-report.
export function totals(items, fields = MACROS, skip = null) {
  const sums = Object.fromEntries(fields.map((m) => [m, 0]));
  const unknown = Object.fromEntries(fields.map((m) => [m, []]));

  for (const { id, qty } of entries) {
    if (skip && skip.has(id)) continue;
    const item = items[id];
    if (!item) continue;
    for (const m of fields) {
      const v = item[m];
      if (v == null) unknown[m].push(item.name);
      else sums[m] += v * qty;
    }
  }
  return { sums, unknown };
}

// Items still carrying no numbers at all, which the label has to resolve before it
// can be honest.
export const missingItems = (items) =>
  entries.map((e) => e.id).filter((id) => items[id]?.no_data);

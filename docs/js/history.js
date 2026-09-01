// Saved plates.
//
// A saved plate carries its own numbers, copied in at save time rather than looked up
// again later. Two reasons, and the second is the important one:
//
//   Items fall out of the export as the 31-day window slides, and totals() silently
//   skips ids it can't find — a month-old plate would quietly lose calories.
//
//   You can correct an item's macros at any time. Without freezing, fixing a bad
//   calorie count in October would rewrite what September says you ate.

import * as store from './store.js';

const KEEP_DAYS = 31;

const all = () => store.get('plates') || [];
const write = (list) => store.set('plates', list);

// Expiry happens on read, so there is nothing to schedule and nothing to forget.
export function list() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const kept = all().filter((p) => Date.parse(p.at) >= cutoff);
  if (kept.length !== all().length) write(kept);
  return kept;
}

export const forDate = (date) => list().filter((p) => p.date === date);
export const datesWithPlates = () => new Set(list().map((p) => p.date));

export function save(entry) {
  // The clock alone is not enough: two saves in the same millisecond would collide,
  // and rename and delete both address plates by id.
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rec = { ...entry, id, at: new Date().toISOString() };
  write([rec, ...list()]);
  return rec;
}

export function rename(id, name) {
  write(list().map((p) => (p.id === id ? { ...p, name } : p)));
}

export function remove(id) {
  write(list().filter((p) => p.id !== id));
}

export const get = (id) => list().find((p) => p.id === id) ?? null;

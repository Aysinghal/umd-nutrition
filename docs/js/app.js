import { loadIndex, loadItems, loadMenu, mealsFor, hasDay } from './data.js';

// Step 1: hall and date are fixed. The chips that change them arrive in step 2.
const HALL = 19;
const PROTEIN_FLOOR = 10;

const state = {
  index: null,
  items: null,
  hall: HALL,
  date: null,
  meal: null,
  rows: [],
};

// --- meal guessing -----------------------------------------------------------

// Hour by which each meal is over. A day only offers some of these, so we pick the
// first one on offer that hasn't ended yet.
const MEAL_ENDS = { Breakfast: 10.5, Brunch: 15, Lunch: 16, Dinner: 24 };

function guessMeal(meals, now = new Date()) {
  const hour = now.getHours() + now.getMinutes() / 60;
  return meals.find((m) => hour < (MEAL_ENDS[m] ?? 24)) ?? meals[meals.length - 1];
}

// --- building the list -------------------------------------------------------

// A dish can sit at several counters in one meal. One row per dish, every station kept.
function collect(menu, mealName, items) {
  const meal = menu.meals.find((m) => m.meal === mealName);
  if (!meal) return [];

  const byId = new Map();
  for (const { station, items: ids } of meal.stations) {
    for (const id of ids) {
      const item = items[id];
      if (!item) continue;
      if (!byId.has(id)) byId.set(id, { id, item, stations: [] });
      byId.get(id).stations.push(station);
    }
  }
  return [...byId.values()];
}

// Protein per calorie. Null whenever we can't honestly compute it — an unknown value
// is never treated as zero.
function ratioOf({ protein, cal }) {
  if (protein == null || cal == null || cal <= 0) return null;
  return protein / cal;
}

function rank(rows) {
  const scored = rows.map((r) => ({ ...r, ratio: ratioOf(r.item) }));

  // Three tiers: real contenders, then everything else that has numbers, then the
  // items we know nothing about. Sorting is by ratio inside each tier.
  const tier = (r) => {
    if (r.ratio == null) return 2;
    return (r.item.protein ?? 0) >= PROTEIN_FLOOR ? 0 : 1;
  };

  return scored.sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    if (a.ratio == null && b.ratio == null) return a.item.name.localeCompare(b.item.name);
    return b.ratio - a.ratio;
  });
}

// --- rendering ---------------------------------------------------------------

const el = (id) => document.getElementById(id);
const num = (v, digits = 0) => (v == null ? '—' : v.toFixed(digits));

function rowHtml(r) {
  const { item, stations, ratio } = r;
  const classes = ['row'];
  if (item.no_data) classes.push('nodata');
  else if ((item.protein ?? 0) < PROTEIN_FLOOR) classes.push('low');

  const where = [stations.join(' · '), item.serving].filter(Boolean).join(' · ');

  const macros = item.no_data
    ? 'no nutrition info'
    : `${num(item.cal)} cal <span class="p">${num(item.protein, 1)} g P</span>` +
      ` <span class="ratio">· ${ratio == null ? '—' : ratio.toFixed(3)} P/cal</span>`;

  return `<div class="${classes.join(' ')}">
    <div class="name">${esc(item.name)}</div>
    <div class="where">${esc(where)}</div>
    <div class="macros">${macros}</div>
  </div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render() {
  const hallName = state.index.halls.find((h) => h.id === state.hall)?.name ?? state.hall;
  el('crumb').innerHTML =
    `${esc(hallName)}<span class="sep">·</span>${esc(state.meal)}` +
    `<span class="sep">·</span><span class="count">${state.rows.length} items</span>`;

  // The floor is a ranking device, not a filter — everything is still on screen, just
  // in order. A divider marks where the contenders stop.
  const parts = [];
  let marked = false;
  for (const r of state.rows) {
    if (!marked && (r.ratio == null || (r.item.protein ?? 0) < PROTEIN_FLOOR)) {
      parts.push(`<div class="divider">under ${PROTEIN_FLOOR} g protein</div>`);
      marked = true;
    }
    parts.push(rowHtml(r));
  }
  el('list').innerHTML = parts.join('') || '<div class="msg">Nothing on the menu.</div>';
}

// --- boot --------------------------------------------------------------------

function today(index) {
  const iso = new Date().toLocaleDateString('en-CA'); // local date, not UTC
  return hasDay(index, state.hall, iso) ? iso : index.dates[0];
}

async function main() {
  try {
    window.__stage = 'fetching index.json + items.json';
    const [index, items] = await Promise.all([loadIndex(), loadItems()]);
    state.index = index;
    state.items = items;
    state.date = today(index);

    const meals = mealsFor(index, state.hall, state.date);
    state.meal = guessMeal(meals);

    window.__stage = `fetching menu ${state.hall}-${state.date}`;
    const menu = await loadMenu(state.hall, state.date);
    // The 29 items whose numbers can't be true stay out until there's a toggle for them.
    const rows = collect(menu, state.meal, items).filter((r) => !r.item.suspect);
    state.rows = rank(rows);

    render();
    window.__stage = 'done';
  } catch (err) {
    el('list').innerHTML = `<div class="msg">Couldn't load: ${esc(err.message)}</div>`;
    throw err;
  }
}

main();

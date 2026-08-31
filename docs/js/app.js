import { loadIndex, loadItems, loadMenu, mealsFor, hasDay } from './data.js';
import { pick, panel, close as closeSheet, isOpen } from './sheet.js';
import * as store from './store.js';
import * as plate from './plate.js';
import { openKeypad } from './keypad.js';
import { buildIndex, suggestFor, FIELDS as SUGGEST_FIELDS } from './suggest.js';
import { labelHtml } from './label.js';

const PROTEIN_FLOOR = 10;

export const DIET_LEVELS = [
  { value: 1, label: 'Vegetarian', note: 'no meat at all' },
  { value: 2, label: '+ chicken & turkey', note: 'vegetarian plus poultry' },
  { value: 3, label: 'No beef', note: 'any meat except beef' },
  { value: 4, label: 'Anything', note: 'no restriction' },
];

const state = {
  index: null,
  items: null,
  menu: null,
  hall: store.get('hall'),
  date: null,
  meal: null,
  level: store.get('level'),
  rows: [],
  loading: true,
  suggestIndex: null,
  labelName: null,
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

// diet_level null means "we couldn't classify it", which must never pass as edible at
// any level. Blocked, not merely ranked last.
const allowedAt = (item, level) => item.diet_level != null && item.diet_level <= level;

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

function rebuild() {
  const rows = collect(state.menu, state.meal, state.items)
    // The 29 items whose numbers can't be true stay out until there's a toggle for them.
    .filter((r) => !r.item.suspect)
    .filter((r) => allowedAt(r.item, state.level));
  state.rows = rank(rows);
}

// --- rendering ---------------------------------------------------------------

const el = (id) => document.getElementById(id);
const num = (v, digits = 0) => (v == null ? '—' : v.toFixed(digits));

// 1, 1.5, 2 — never 1.0
const fmtQty = (q) => (Number.isInteger(q) ? String(q) : q.toFixed(1));

// "Yahentamitsi Dining Hall" is too long for a chip; the suffix carries no information.
const shortHall = (name) => name.replace(/ Dining Hall$/, '');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

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

  const qty = plate.qtyOf(r.id);

  return `<div class="${classes.join(' ')}">
    <div class="row-main">
      <div class="name">${esc(item.name)}</div>
      <div class="where">${esc(where)}</div>
      <div class="macros">${macros}</div>
    </div>
    <button class="add${qty ? ' on' : ''}" data-add="${esc(r.id)}"
      aria-label="Add ${esc(item.name)}">${qty ? fmtQty(qty) + '×' : '+'}</button>
  </div>`;
}

function renderBar() {
  const hall = state.index.halls.find((h) => h.id === state.hall)?.name ?? String(state.hall);
  el('crumb').innerHTML = `
    <button class="chip" data-chip="hall">${esc(shortHall(hall))}<i>▾</i></button>
    <button class="chip" data-chip="meal">${esc(state.meal ?? '—')}<i>▾</i></button>
    <button class="chip lvl" data-chip="level" title="Tap to cycle, hold to choose">Lvl ${state.level}<i>▾</i></button>
    <span class="count">${state.loading ? '…' : state.rows.length}</span>`;
}

function renderList() {
  if (state.loading) {
    el('list').innerHTML = '<div class="msg">Loading menu…</div>';
    return;
  }

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
  el('list').innerHTML = parts.join('') || '<div class="msg">Nothing matches at this diet level.</div>';
}

// The dock grows when the plate has food on it, so the list's bottom padding and the
// toast's offset can't be a fixed number.
function syncDockHeight() {
  const h = el('dock').offsetHeight;
  document.documentElement.style.setProperty('--dock-h', `${h}px`);
}

function render() {
  renderBar();
  renderList();
  renderPlate();
  syncDockHeight();
}

// --- undo ---------------------------------------------------------------------

let toastTimer = null;

function toast(message, undo) {
  const box = el('toast');
  box.innerHTML = `<span>${esc(message)}</span><button data-undo>Undo</button>`;
  box.hidden = false;
  box.querySelector('[data-undo]').onclick = () => {
    undo();
    box.hidden = true;
    renderPlate();
    renderList();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

function wireList() {
  el('list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const id = btn.dataset.add;
    const before = plate.qtyOf(id);
    plate.add(id);
    renderPlate();
    // Repaint just this button rather than the whole list, so the scroll position
    // doesn't jump out from under a thumb mid-tap.
    btn.textContent = `${fmtQty(plate.qtyOf(id))}×`;
    btn.classList.add('on');
    syncDockHeight();
    toast(`Added ${state.items[id]?.name ?? 'item'}`, () => plate.setQty(id, before));
  });

  el('plate').addEventListener('click', openPlatePanel);
}

// --- the FoodNoms label -------------------------------------------------------

const FILL_LABELS = { cal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

let skipped = new Set();

// Merges saved estimates into the loaded items, so an item you've filled in once
// stops behaving like a no-data item everywhere — list, totals and label alike.
function applyEstimates() {
  const saved = store.get('estimates') || {};
  for (const [id, values] of Object.entries(saved)) {
    const item = state.items[id];
    if (item) Object.assign(item, values, { no_data: false, estimated: true });
  }
}

function saveEstimate(id, values) {
  const saved = { ...(store.get('estimates') || {}) };
  saved[id] = values;
  store.set('estimates', saved);
  applyEstimates();
}

function plateName() {
  const hall = state.index.halls.find((h) => h.id === state.hall)?.name ?? '';
  const when = new Date(`${state.date}T12:00:00`)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${shortHall(hall)} ${state.meal} \u2014 ${when}`;
}

// Walk the plate's no-data items one at a time, then show the label.
function labelFlow() {
  const pending = plate.missingItems(state.items).filter((id) => !skipped.has(id));
  if (pending.length) openFillIn(pending[0], null);
  else showLabel();
}

function openFillIn(id, carried) {
  const item = state.items[id];
  const hint = suggestFor(item, state.suggestIndex);
  const draft = carried ?? { ...(hint?.values ?? { cal: 0, protein: 0, carbs: 0, fat: 0 }) };

  panel({
    title: item.name,
    html: `
      <p class="pad-sub">No nutrition info on the menu. Enter what you'd log.</p>
      <div class="fill-list">
        ${SUGGEST_FIELDS.map((f) => `<button class="fill-row" data-field="${f}">
          <span>${FILL_LABELS[f]}</span>
          <span class="fill-v">${draft[f]}${f === 'cal' ? '' : ' g'}</span>
        </button>`).join('')}
      </div>
      ${hint
        ? `<p class="fill-src">suggested from<br><b>${esc(hint.from.name)}</b> \u00b7 ${esc(hint.from.serving || '')}</p>`
        : '<p class="fill-src">no similar item to suggest from</p>'}
      <div class="fill-actions">
        <button data-skip>Skip this item</button>
        <button class="go" data-save>Save</button>
      </div>`,
    onClick: (e) => {
      if (e.target.closest('[data-skip]')) { skipped.add(id); labelFlow(); return; }
      if (e.target.closest('[data-save]')) { saveEstimate(id, draft); render(); labelFlow(); return; }

      const field = e.target.closest('[data-field]');
      if (!field) return;
      const f = field.dataset.field;
      openKeypad({
        title: `${item.name} \u00b7 ${FILL_LABELS[f]}`,
        subtitle: 'per serving, as you take it',
        initial: draft[f],
        // Reopen the same form with the new value carried over.
        onDone: (v) => openFillIn(id, { ...draft, [f]: v }),
      });
    },
  });
}

function showLabel() {
  closeSheet();
  const { sums } = plate.totals(state.items, plate.LABEL_FIELDS, skipped);
  const left = [...skipped].map((id) => state.items[id]?.name).filter(Boolean);

  const view = el('labelview');
  view.innerHTML = `
    <div class="lv-bar">
      <button data-close-label>Done</button>
      <input id="lv-name" value="${esc(state.labelName ?? plateName())}" aria-label="Label name">
    </div>
    ${left.length ? `<p class="lv-warn">Not included: ${esc(left.join(', '))}</p>` : ''}
    ${labelHtml({ name: state.labelName ?? plateName(), servingSize: '1 plate', sums })}
    <p class="lv-note">Turn your screen brightness up before scanning.</p>`;
  view.hidden = false;

  const nameInput = view.querySelector('#lv-name');
  nameInput.oninput = () => {
    state.labelName = nameInput.value;
    view.querySelector('.lb-name').textContent = nameInput.value;
  };
  view.querySelector('[data-close-label]').onclick = () => { view.hidden = true; };
}

// --- the plate ---------------------------------------------------------------

const MACRO_DP = { cal: 0, protein: 1, carbs: 1, fat: 1, fiber: 1 };

// A total built from any unknown value is a floor, not an answer. Say so with a "+"
// rather than quietly under-reporting something that's about to be logged.
function fmtTotal(macro, sums, unknown) {
  const v = sums[macro].toFixed(MACRO_DP[macro]);
  return unknown[macro].length ? `${v}+` : v;
}

function renderPlate() {
  const btn = el('plate');
  if (plate.isEmpty()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;

  const { sums, unknown } = plate.totals(state.items);
  const n = plate.servings();

  const bars = ['cal', 'protein']
    .map((m) => {
      const t = plate.TARGETS[m];
      const pct = t.on && t.value ? Math.min(100, (sums[m] / t.value) * 100) : 0;
      const over = t.on && t.value && sums[m] > t.value;
      return `<div class="tgt">
        <span class="tgt-k">${m === 'cal' ? 'cal' : 'P'}</span>
        <span class="bar"><span class="fill${over ? ' over' : ''}" style="width:${pct}%"></span></span>
        <span class="tgt-v">${fmtTotal(m, sums, unknown)}<span class="of">/${t.value}</span></span>
      </div>`;
    })
    .join('');

  btn.innerHTML = `<div class="plate-top">
      <span>${fmtQty(n)} item${n === 1 ? '' : 's'}</span>
      <span class="caret">\u25b2</span>
    </div>${bars}`;
}

function platePanelHtml() {
  const { sums, unknown } = plate.totals(state.items);

  const rows = plate.list().map(({ id, qty }) => {
    const item = state.items[id];
    if (!item) return '';
    return `<div class="pline" data-id="${esc(id)}">
      <div class="pline-name">${esc(item.name)}</div>
      <div class="pline-sub">${[esc(item.serving || ''), item.no_data ? 'no nutrition info'
        : `${num(item.cal * qty)} cal, ${num((item.protein ?? 0) * qty, 1)} g P`]
        .filter(Boolean).join(' \u00b7 ')}</div>
      <div class="stepper">
        <button data-step="-1" aria-label="Less">\u2212</button>
        <button class="qty" data-qty aria-label="Type a quantity">${fmtQty(qty)}\u00d7</button>
        <button data-step="1" aria-label="More">+</button>
      </div>
    </div>`;
  }).join('');

  const totals = plate.MACROS.map((m) => {
    const t = plate.TARGETS[m];
    const val = fmtTotal(m, sums, unknown);
    const unit = plate.UNITS[m];
    if (!t.on || !t.value) {
      return `<div class="trow off">
        <span class="trow-k">${plate.LABELS[m]}</span>
        <span class="trow-v">${val} ${unit}</span>
      </div>`;
    }
    const pct = Math.min(100, (sums[m] / t.value) * 100);
    const over = sums[m] > t.value;
    return `<div class="trow">
      <span class="trow-k">${plate.LABELS[m]}</span>
      <span class="bar"><span class="fill${over ? ' over' : ''}" style="width:${pct}%"></span></span>
      <span class="trow-v">${val}<span class="of">/${t.value}</span></span>
    </div>`;
  }).join('');

  // Name the items actually responsible, so it's obvious what to double-check.
  const missing = [...new Set(Object.values(unknown).flat())];
  const warn = missing.length
    ? `<p class="warn-note">Totals are a minimum. No numbers for ${esc(missing.join(', '))}.</p>`
    : '';

  return `<div class="plines">${rows}</div>${warn}
    <div class="totals">${totals}</div>
    <div class="panel-actions">
      <button class="go" data-label>Nutrition label</button>
      <button class="danger" data-clear>Clear plate</button>
    </div>`;
}

function openQtyPad(id) {
  const item = state.items[id];
  openKeypad({
    title: item?.name ?? 'Quantity',
    subtitle: item?.no_data
      ? `${item.serving || ''} \u00b7 no nutrition info`
      : `${item?.serving || ''} \u00b7 ${num(item?.cal)} cal, ${num(item?.protein, 1)} g P each`,
    initial: plate.qtyOf(id),
    onDone: (qty) => {
      plate.setQty(id, qty);
      renderPlate();
      renderList();
      syncDockHeight();
      if (plate.isEmpty()) closeSheet();
      else openPlatePanel(); // straight back to the plate, not a dead end
    },
  });
}

function openPlatePanel() {
  const update = panel({
    title: 'Plate',
    html: platePanelHtml(),
    onClick: (e) => {
      const line = e.target.closest('.pline');
      if (e.target.closest('[data-label]')) {
        skipped = new Set();
        labelFlow();
        return;
      }
      if (e.target.closest('[data-clear]')) {
        plate.clear();
        state.labelName = null;
        closeSheet();
        render();
        return;
      }
      if (!line) return;
      const id = line.dataset.id;
      if (e.target.closest('[data-qty]')) { openQtyPad(id); return; }

      const step = e.target.closest('[data-step]');
      if (step) plate.setQty(id, plate.qtyOf(id) + Number(step.dataset.step));
      else return;

      if (plate.isEmpty()) closeSheet();
      else update(platePanelHtml());
      renderPlate();
      renderList();
      syncDockHeight();
    },
  });
}

// --- changing things ---------------------------------------------------------

async function setHall(hall) {
  if (hall === state.hall) return;
  state.hall = hall;
  state.labelName = null;
  store.set('hall', hall);
  await refreshDay();
}

// Halls don't all serve the same meals on a given day, so a meal can vanish under us.
async function refreshDay() {
  state.loading = true;
  render();

  const meals = mealsFor(state.index, state.hall, state.date);
  if (!meals.includes(state.meal)) state.meal = guessMeal(meals);

  state.menu = await loadMenu(state.hall, state.date);
  state.loading = false;
  rebuild();
  render();
}

function setMeal(meal) {
  if (meal === state.meal) return;
  state.meal = meal; // deliberately not stored: the clock guesses this each time
  state.labelName = null;
  rebuild();
  render();
}

function setLevel(level) {
  state.level = level;
  store.set('level', level);
  rebuild();
  render();
}

// --- chip interaction --------------------------------------------------------

function openHallSheet() {
  pick({
    title: 'Dining hall',
    current: state.hall,
    options: state.index.halls
      .filter((h) => hasDay(state.index, h.id, state.date))
      .map((h) => ({ value: h.id, label: h.name })),
    onPick: setHall,
  });
}

function openMealSheet() {
  pick({
    title: 'Meal',
    current: state.meal,
    options: mealsFor(state.index, state.hall, state.date).map((m) => ({ value: m, label: m })),
    onPick: setMeal,
  });
}

function openLevelSheet() {
  pick({ title: 'Diet level', current: state.level, options: DIET_LEVELS, onPick: setLevel });
}

function wireBar() {
  const bar = el('bar');
  let held = false;
  let timer = null;

  const cancel = () => clearTimeout(timer);

  bar.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip || chip.dataset.chip !== 'level') return;
    held = false;
    timer = setTimeout(() => {
      held = true;
      openLevelSheet();
    }, 450);
  });
  bar.addEventListener('pointerup', cancel);
  bar.addEventListener('pointercancel', cancel);
  bar.addEventListener('pointermove', cancel);

  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    if (chip.dataset.chip === 'hall') openHallSheet();
    else if (chip.dataset.chip === 'meal') openMealSheet();
    else if (chip.dataset.chip === 'level') {
      if (held) { held = false; return; } // the long-press already opened the sheet
      setLevel((state.level % 4) + 1);
    }
  });
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
    state.suggestIndex = buildIndex(items);
    applyEstimates();

    // A remembered hall might not be serving today; fall back to one that is.
    if (!index.halls.some((h) => h.id === state.hall)) state.hall = index.halls[0].id;
    state.date = today(index);
    if (!hasDay(index, state.hall, state.date)) {
      state.hall = index.halls.find((h) => hasDay(index, h.id, state.date))?.id ?? state.hall;
    }

    state.meal = guessMeal(mealsFor(index, state.hall, state.date));

    window.__stage = `fetching menu ${state.hall}-${state.date}`;
    state.menu = await loadMenu(state.hall, state.date);
    state.loading = false;

    rebuild();
    render();
    wireBar();
    wireList();
    store.requestPersistence();
    window.__stage = 'done';
  } catch (err) {
    el('list').innerHTML = `<div class="msg">Couldn't load: ${esc(err.message)}</div>`;
    throw err;
  }
}

main();

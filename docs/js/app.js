import { loadIndex, loadItems, loadMenu, mealsFor, hasDay, dataAgeDays } from './data.js';
import { pick, panel, close as closeSheet, isOpen } from './sheet.js';
import * as store from './store.js';
import * as plate from './plate.js';
import { openKeypad } from './keypad.js';
import { buildIndex, suggestFor, FIELDS as SUGGEST_FIELDS } from './suggest.js';
import { labelHtml } from './label.js';
import { openDetail } from './detail.js';
import * as overrides from './overrides.js';
import { esc, num, fmtQty } from './util.js';
import { get as getFilters } from './filters.js';
import { draggable } from './drag.js';
import { openSettings } from './settings.js';
import { backupAge } from './backup.js';

const floor = () => getFilters().floor;

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
  tempTargets: null,   // this-meal-only target changes; never stored
};

// --- meal guessing -----------------------------------------------------------

// Hour by which each meal is over. A day only offers some of these, so we pick the
// first one on offer that hasn't ended yet.
const MEAL_ENDS = { Breakfast: 10.5, Brunch: 15, Lunch: 16, Dinner: 24 };

function guessMeal(meals, now = new Date()) {
  const hour = now.getHours() + now.getMinutes() / 60;
  return meals.find((m) => hour < (MEAL_ENDS[m] ?? 24)) ?? meals[meals.length - 1];
}

const MEAL_MEMORY = 60 * 60 * 1000;

// iOS drops background tabs and reloads them. Re-guessing from the clock on every
// reload means checking dinner at 5pm, glancing away, and coming back to lunch — or
// the reverse. So the last meal sticks for an hour before the clock takes over again.
// The stamp records when the meal was decided, not when it was last shown. Otherwise
// opening the app every half hour would keep renewing the hour and the clock would
// never get a turn.
function pickMeal(meals) {
  const last = store.get('meal');
  const fresh = Date.now() - (store.get('mealAt') || 0) < MEAL_MEMORY;
  if (fresh && meals.includes(last)) return last;
  const guess = guessMeal(meals);
  rememberMeal(guess);
  return guess;
}

function rememberMeal(meal) {
  store.set('meal', meal);
  store.set('mealAt', Date.now());
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

// Flagged items can never win a ranking — their numbers are the reason they're flagged.
const SORTERS = {
  ratio: (a, b) => b.ratio - a.ratio,
  protein: (a, b) => (b.item.protein ?? 0) - (a.item.protein ?? 0),
  cal: (a, b) => (a.item.cal ?? 0) - (b.item.cal ?? 0),
};

function rank(rows, sort = 'ratio') {
  const scored = rows.map((r) => ({ ...r, ratio: ratioOf(r.item) }));
  const by = SORTERS[sort] || SORTERS.ratio;

  // Four tiers: real contenders, then everything else that has numbers, then flagged
  // items, then the ones we know nothing about.
  const tier = (r) => {
    if (r.item.suspect) return 2;
    if (r.ratio == null) return 3;
    return (r.item.protein ?? 0) >= floor() ? 0 : 1;
  };

  return scored.sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    if (a.ratio == null && b.ratio == null) return a.item.name.localeCompare(b.item.name);
    return by(a, b);
  });
}

function rebuild() {
  const f = getFilters();
  const rows = collect(state.menu, state.meal, state.items)
    .filter((r) => f.showFlagged || !r.item.suspect)
    .filter((r) => allowedAt(r.item, state.level))
    // Hides items that declare the allergen. An item declaring none isn't proven
    // free of it — see the note in the filters sheet.
    .filter((r) => !f.avoid.some((a) => (r.item.allergens || []).includes(a)));
  state.rows = rank(rows, f.sort);
}

// --- rendering ---------------------------------------------------------------

const el = (id) => document.getElementById(id);

// "Yahentamitsi Dining Hall" is too long for a chip; the suffix carries no information.
const shortHall = (name) => name.replace(/ Dining Hall$/, '');

function rowHtml(r) {
  const { item, stations, ratio } = r;
  const classes = ['row'];
  if (item.suspect) classes.push('flagged');
  if (item.no_data) classes.push('nodata');
  else if ((item.protein ?? 0) < floor()) classes.push('low');

  const where = [stations.join(' · '), item.serving].filter(Boolean).join(' · ');

  const badge = item.override
    ? ` <span class="ov-badge">${esc(overrides.SOURCES[item.override].short)}</span>`
    : '';

  const macros = item.no_data
    ? 'no nutrition info'
    : `${num(item.cal)} cal <span class="p">${num(item.protein, 1)} g P</span>` +
      ` <span class="ratio">· ${ratio == null ? '—' : ratio.toFixed(3)} P/cal</span>` + badge;

  const qty = plate.qtyOf(r.id);

  return `<div class="${classes.join(' ')}" data-row="${esc(r.id)}">
    <div class="row-main">
      <div class="name">${esc(item.name)}</div>
      <div class="where">${esc(where)}</div>
      <div class="macros">${macros}</div>
      ${item.suspect ? `<div class="flag-why">${esc(item.suspect)}</div>` : ''}
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
    <button class="count" data-chip="filters" aria-label="Filters"><span class="cnum">${
      state.loading ? '…' : state.rows.length}</span><i class="fi">≡</i></button>`;
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
    if (!marked && (r.ratio == null || (r.item.protein ?? 0) < floor())) {
      parts.push(`<div class="divider">under ${floor()} g protein</div>`);
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

// The spacer earns its space: what you're looking at, and how fresh it is.
function renderHero() {
  const hall = state.index.halls.find((h) => h.id === state.hall);
  const day = new Date(`${state.date}T12:00:00`);
  const over = state.rows.filter((r) => (r.item.protein ?? 0) >= floor()).length;

  el('hero-date').textContent =
    day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  el('hero-where').textContent = hall ? shortHall(hall.name) : 'UMD Nutrition';
  el('hero-sub').textContent = state.loading
    ? state.meal ?? ''
    : `${state.meal} · ${state.rows.length} items, ${over} over ${floor()} g protein`;
  const age = backupAge();
  const nudge = age.stale
    ? `<button class="hero-nudge" id="hero-nudge">${
        age.days == null ? 'never backed up' : `last backed up ${age.days} days ago`}</button>`
    : '';
  const dataAge = dataAgeDays();
  const when = dataAge === 0 ? 'menu updated today' : `data from ${esc(state.builtOn ?? '')}`;
  el('hero-meta').innerHTML = `${when}${nudge}`;
  el('hero-meta').classList.toggle('hero-stale', dataAge != null && dataAge >= 1);
  const n = el('hero-nudge');
  if (n) n.onclick = () => openSettings(() => { rebuild(); render(); });
}

function render() {
  renderHero();
  renderBar();
  renderList();
  renderPlate();
  syncDockHeight();
}

// --- undo ---------------------------------------------------------------------

let toastTimer = null;

// Flagged items you've acknowledged this session.
const confirmedFlagged = new Set();

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
    const row = e.target.closest('[data-row]');
    const btn = e.target.closest('[data-add]');
    if (!btn) {
      if (row) showDetail(row.dataset.row);
      return;
    }
    const id = btn.dataset.add;
    // Adding numbers you can see are wrong should take a deliberate second tap.
    if (state.items[id]?.suspect && !plate.qtyOf(id) && !confirmedFlagged.has(id)) {
      confirmedFlagged.add(id);
      toast(`${state.items[id].name}: numbers can't be true. Tap + again to add anyway.`,
        () => confirmedFlagged.delete(id));
      return;
    }
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

function showDetail(id) {
  const item = state.items[id];
  if (!item) return;
  const row = state.rows.find((r) => r.id === id);
  openDetail({
    id,
    item,
    items: state.items,
    stations: row ? row.stations : [],
    suggestIndex: state.suggestIndex,
    onChange: () => { rebuild(); render(); },
    // Label a single item at whatever amount you actually took.
    onLabel: (itemId, qty) => {
      closeSheet();
      showSingleLabel(itemId, qty);
    },
  });
}

function showSingleLabel(id, qty) {
  const item = state.items[id];
  const sums = Object.fromEntries(plate.LABEL_FIELDS.map((f) => [f, (item[f] || 0) * qty]));
  const view = el('labelview');
  view.innerHTML = `
    <div class="lv-grab"><span></span></div>
    ${item.no_data ? '<p class="lv-warn">This item has no published nutrition. The label below is all zeroes.</p>' : ''}
    ${labelHtml({
      name: item.name,
      servingSize: `${fmtQty(qty)} \u00d7 ${item.serving || 'serving'}`,
      sums,
    })}
    <p class="lv-note">Turn your screen brightness up before scanning.</p>
    <div class="lv-bar">
      <span class="lv-single">${esc(item.name)}</span>
      <button data-close-label>Done</button>
    </div>`;
  view.hidden = false;
  view.querySelector('[data-close-label]').onclick = () => { view.hidden = true; };
  wireLabelDrag();
}

// --- the FoodNoms label -------------------------------------------------------

const FILL_LABELS = { cal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

let skipped = new Set();

function applyEstimates() {
  overrides.applyTo(state.items);
}

function saveEstimate(id, values) {
  const item = state.items[id];
  const hint = suggestFor(item, state.suggestIndex);
  overrides.set(id, { values, source: 'estimate', basis: hint ? hint.from.name : null });
  overrides.applyTo(state.items);
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

let labelDrag = null;

function wireLabelDrag() {
  const view = el('labelview');
  if (labelDrag) { labelDrag.reset(); return; }
  labelDrag = draggable(view, {
    scroller: view,
    handle: '.lv-grab',
    onClose: () => { view.hidden = true; },
  });
}

function showLabel() {
  closeSheet();
  const { sums } = plate.totals(state.items, plate.LABEL_FIELDS, skipped);
  const left = [...skipped].map((id) => state.items[id]?.name).filter(Boolean);

  const view = el('labelview');
  view.innerHTML = `
    <div class="lv-grab"><span></span></div>
    ${left.length ? `<p class="lv-warn">Not included: ${esc(left.join(', '))}</p>` : ''}
    ${labelHtml({ name: state.labelName ?? plateName(), servingSize: '1 plate', sums })}
    <p class="lv-note">Turn your screen brightness up before scanning.</p>
    <div class="lv-bar">
      <input id="lv-name" value="${esc(state.labelName ?? plateName())}" aria-label="Label name">
      <button data-close-label>Done</button>
    </div>`;
  view.hidden = false;

  const nameInput = view.querySelector('#lv-name');
  nameInput.oninput = () => {
    state.labelName = nameInput.value;
    view.querySelector('.lb-name').textContent = nameInput.value;
  };
  view.querySelector('[data-close-label]').onclick = () => { view.hidden = true; };
  wireLabelDrag();
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

  const tg = plate.targets(state.tempTargets);
  const bars = ['cal', 'protein']
    .map((m) => {
      const t = tg[m];
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

  const tg = plate.targets(state.tempTargets);
  const totals = plate.MACROS.map((m) => {
    const t = tg[m];
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
    return `<button class="trow" data-target="${m}">
      <span class="trow-k">${plate.LABELS[m]}</span>
      <span class="bar"><span class="fill${over ? ' over' : ''}" style="width:${pct}%"></span></span>
      <span class="trow-v">${val}<span class="of">/${t.value}</span>${
        t.temp ? `<span class="of tmp">was ${t.def}</span>` : ''}</span>
    </button>`;
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
      const tgt = e.target.closest('[data-target]');
      if (tgt) {
        const m = tgt.dataset.target;
        const cur = plate.targets(state.tempTargets)[m];
        return openKeypad({
          title: `${plate.LABELS[m]} target`,
          subtitle: `this meal only · default ${cur.def}`,
          initial: cur.value,
          onDone: (v) => {
            state.tempTargets = { ...state.tempTargets, [m]: v };
            renderPlate();
            openPlatePanel();
          },
        });
      }
      if (e.target.closest('[data-label]')) {
        skipped = new Set();
        labelFlow();
        return;
      }
      if (e.target.closest('[data-clear]')) {
        plate.clear();
        state.labelName = null;
        state.tempTargets = null;
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
  if (!meals.includes(state.meal)) state.meal = pickMeal(meals);

  state.menu = await loadMenu(state.hall, state.date);
  state.loading = false;
  rebuild();
  render();
}

function setMeal(meal) {
  if (meal === state.meal) return;
  state.meal = meal;
  rememberMeal(meal);
  state.labelName = null;
  state.tempTargets = null;
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
    if (chip.dataset.chip === 'filters') openSettings(() => { rebuild(); render(); });
    else if (chip.dataset.chip === 'hall') openHallSheet();
    else if (chip.dataset.chip === 'meal') openMealSheet();
    else if (chip.dataset.chip === 'level') {
      if (held) { held = false; return; } // the long-press already opened the sheet
      setLevel((state.level % 4) + 1);
    }
  });
}

// --- offline ------------------------------------------------------------------

// Anything longer than this away from the app and it's worth a fresh look on the way
// back. Shorter than this is switching to the camera and switching straight back.
const RETURN_AFTER = 5 * 60 * 1000;

// Nothing re-checks the clock while the page is alive: the date and the meal are both
// worked out at boot and never move again, and there is no timer. A Home Screen app can
// sit in memory for days, and there is no pull-to-refresh here either — the body is
// pinned so sheets don't bounce the page. So without this you can open at 6pm and still
// be reading the lunch menu.
//
// Two hours is the gap between meals. Shorter than that is putting your phone in your
// pocket partway through one.
//
// The date is checked as well as the age, for the narrow case of loading late at night
// and coming back after midnight: a different day, but under two hours.
//
// Safe to reload with no signal, which it would not have been before the cache existed.
const STALE_AFTER = 2 * 60 * 60 * 1000;
const bootDay = todayISO();
const bootAt = Date.now();

function reloadIfStale() {
  if (todayISO() !== bootDay || Date.now() - bootAt > STALE_AFTER) location.reload();
}

function initOffline() {
  // The staleness guard has nothing to do with caching and must not be skipped with it.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    // Checked on every return, however brief the trip away was: what matters is how
    // old the page is, not how long you were gone.
    reloadIfStale();
    if (Date.now() - hiddenAt > RETURN_AFTER) syncData();
  });

  // iOS can restore a page from the back/forward cache without firing visibilitychange.
  window.addEventListener('pageshow', (e) => { if (e.persisted) reloadIfStale(); });

  if (!navigator.serviceWorker) return;

  // updateViaCache 'none' is load-bearing. Pages serves everything with a ten minute
  // cache; without this the browser can hand back the old worker for ten more minutes
  // after a deploy, and a stuck worker is the one failure with no obvious way out.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  syncData();
}

// Pulls a fresh export onto the phone for next time. Deliberately does not re-render:
// nothing should move while you're mid-decision in front of the counter.
function syncData() {
  navigator.serviceWorker?.ready
    .then((reg) => reg.active?.postMessage({ type: 'sync' }))
    .catch(() => {});
}

// --- boot --------------------------------------------------------------------

// A declaration, not a const arrow: the day-rollover guard higher up calls this at
// module load, before this line would have finished evaluating.
function todayISO() {
  return new Date().toLocaleDateString('en-CA'); // local date, not UTC
}

function today(index) {
  const iso = todayISO();
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

    state.meal = pickMeal(mealsFor(index, state.hall, state.date));

    const built = new Date(index.generated_at);
    state.builtOn = built.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    window.__stage = `fetching menu ${state.hall}-${state.date}`;
    state.menu = await loadMenu(state.hall, state.date);
    state.loading = false;

    rebuild();
    render();
    wireBar();
    wireList();
    store.requestPersistence();
    initOffline();
    window.__stage = 'done';
  } catch (err) {
    el('list').innerHTML = `<div class="msg">Couldn't load: ${esc(err.message)}</div>`;
    throw err;
  }
}

main();

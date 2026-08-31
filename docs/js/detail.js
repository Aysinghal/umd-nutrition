// Everything the app knows about one item, plus the ways to correct it.

import { panel, close as closeSheet } from './sheet.js';
import { openKeypad } from './keypad.js';
import * as plate from './plate.js';
import * as overrides from './overrides.js';
import { suggestFor } from './suggest.js';
import { esc, num, fmtQty } from './util.js';

const FIELD_LABELS = { cal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

const ROWS = [
  ['cal', 'Calories', '', 0],
  ['protein', 'Protein', 'g', 1],
  ['fat', 'Total Fat', 'g', 1],
  ['sat_fat', 'Saturated Fat', 'g', 1, true],
  ['trans_fat', 'Trans Fat', 'g', 1, true],
  ['chol', 'Cholesterol', 'mg', 0],
  ['sodium', 'Sodium', 'mg', 0],
  ['carbs', 'Total Carbohydrate', 'g', 1],
  ['fiber', 'Dietary Fiber', 'g', 1, true],
  ['sugar', 'Total Sugars', 'g', 1, true],
  ['added_sugar', 'Added Sugars', 'g', 1, true],
];

const LEVEL_TEXT = {
  1: 'Vegetarian, so it passes at every diet level.',
  2: 'Contains poultry. Needs level 2 or higher.',
  3: 'Contains meat other than beef. Needs level 3 or higher.',
  4: 'Contains beef. Only shows at level 4.',
};

let ctx = null;

export function openDetail(opts) {
  ctx = { ...opts, qty: plate.qtyOf(opts.id) || 1 };
  render();
}

function nutritionRows(item, qty) {
  return ROWS.map(([key, label, unit, dp, indent]) => {
    const v = item[key];
    const shown = v == null ? '\u2014' : `${num(v * qty, dp)} ${unit}`.trim();
    return `<div class="d-row${indent ? ' d-in' : ''}"><span>${label}</span><span>${shown}</span></div>`;
  }).join('');
}

function render() {
  const { id, item, stations, qty } = ctx;
  const ov = overrides.get(id);
  const src = ov ? overrides.SOURCES[ov.source] : null;

  // How loudly the app invites a correction depends on how bad the data is. An item
  // with nothing gets a real button; an ordinary item gets a quiet link.
  const invite = item.no_data
    ? '<button class="go d-fix" data-fix>Add numbers</button>'
    : item.suspect
      ? '<button class="go d-fix" data-fix>Fix these numbers</button>'
      : '<button class="d-edit" data-fix>Edit numbers</button>';

  panel({
    title: item.name,
    html: `
      <p class="d-sub">${esc([stations.join(' \u00b7 '), item.serving].filter(Boolean).join(' \u00b7 '))}</p>
      ${src ? `<p class="d-src">Numbers ${esc(src.short)}${ov.basis ? `, based on <b>${esc(ov.basis)}</b>` : ''}
                 <button class="d-revert" data-revert>revert</button></p>` : ''}
      ${item.no_data ? '<p class="d-warn">The menu publishes no nutrition for this item.</p>' : ''}
      ${item.suspect ? `<p class="d-warn">These numbers can't be true: ${esc(item.suspect)}.
        They are excluded from ranking. Edit them below to fix it.</p>` : ''}
      <div class="d-nums">${nutritionRows(item, qty)}</div>
      <p class="d-diet">${esc(item.diet_level == null
        ? 'Could not be classified, so it is blocked at every diet level.'
        : LEVEL_TEXT[item.diet_level])}</p>
      ${item.allergens && item.allergens.length
        ? `<p class="d-allerg"><b>Contains:</b> ${esc(item.allergens.join(', '))}</p>`
        : '<p class="d-allerg d-dim">No allergens listed.</p>'}
      <div class="stepper d-step">
        <button data-q="-1" aria-label="Less">\u2212</button>
        <button class="qty" data-qty>${fmtQty(qty)}\u00d7</button>
        <button data-q="1" aria-label="More">+</button>
      </div>
      <div class="fill-actions">
        <button class="go" data-add>${plate.qtyOf(id) ? 'Update plate' : 'Add to plate'}</button>
        <button data-label>Label</button>
      </div>
      <div class="d-editrow">${invite}</div>`,
    onClick: handle,
  });
}

function handle(e) {
  const { id, item, qty } = ctx;

  const q = e.target.closest('[data-q]');
  if (q) {
    ctx.qty = Math.max(0.25, Math.round((qty + Number(q.dataset.q)) * 100) / 100);
    return render();
  }
  if (e.target.closest('[data-qty]')) {
    return openKeypad({
      title: item.name,
      subtitle: 'how much are you taking?',
      initial: qty,
      onDone: (v) => { ctx.qty = v || 1; render(); },
    });
  }
  if (e.target.closest('[data-add]')) {
    plate.setQty(id, ctx.qty);
    closeSheet();
    return ctx.onChange();
  }
  if (e.target.closest('[data-label]')) return ctx.onLabel(id, ctx.qty);
  if (e.target.closest('[data-revert]')) {
    overrides.revert(ctx.items, id);
    ctx.onChange();
    return render();
  }
  if (e.target.closest('[data-fix]')) return openOverride();
}

function openOverride(carried, source) {
  const { id, item } = ctx;
  const existing = overrides.get(id);
  const blank = item.no_data || item._wasNoData;
  const hint = blank ? suggestFor(item, ctx.suggestIndex) : null;
  // What UMD published, so an edit never hides the figure it replaced.
  const published = blank ? null : (item._published || item);

  const draft = carried
    || (existing && { ...existing.values })
    || (hint && { ...hint.values })
    || Object.fromEntries(overrides.FIELDS.map((f) => [f, item[f] || 0]));
  // Typing a number in makes it your estimate unless you say otherwise.
  const chosen = source || (existing && existing.source) || 'estimate';

  panel({
    title: `${item.name} \u2014 numbers`,
    html: `
      ${blank
        ? '<p class="pad-sub">No nutrition info on the menu. Enter what you would log.</p>'
        : '<p class="d-warn">This replaces the published numbers. Your values are used everywhere, including labels.</p>'}
      <div class="fill-list">
        ${overrides.FIELDS.map((f) => `<button class="fill-row" data-field="${f}">
          <span>${FIELD_LABELS[f]}</span>
          <span class="fill-v">${draft[f]}${f === 'cal' ? '' : ' g'}</span>
        </button>`).join('')}
      </div>
      <p class="d-srclabel">These numbers are</p>
      <div class="d-sources">
        ${Object.entries(overrides.SOURCES).map(([k, v]) =>
          `<button class="d-source${k === chosen ? ' on' : ''}" data-source="${k}">${v.label}</button>`).join('')}
      </div>
      ${hint ? `<p class="fill-src">suggested from<br><b>${esc(hint.from.name)}</b> \u00b7 ${esc(hint.from.serving || '')}</p>` : ''}
      <div class="fill-actions">
        <button data-back>Cancel</button>
        <button class="go" data-save>Save</button>
      </div>`,
    onClick: (e) => {
      if (e.target.closest('[data-back]')) return render();

      const srcBtn = e.target.closest('[data-source]');
      if (srcBtn) return openOverride(draft, srcBtn.dataset.source);

      if (e.target.closest('[data-save]')) {
        overrides.set(id, {
          values: draft,
          source: chosen,
          basis: chosen === 'estimate' && hint ? hint.from.name : null,
        });
        overrides.applyTo(ctx.items);
        ctx.onChange();
        return render();
      }

      const field = e.target.closest('[data-field]');
      if (!field) return;
      const f = field.dataset.field;
      openKeypad({
        title: `${item.name} \u00b7 ${FIELD_LABELS[f]}`,
        subtitle: 'per serving as the menu lists it',
        initial: draft[f],
        onDone: (v) => openOverride({ ...draft, [f]: v }, chosen),
      });
    },
  });
}

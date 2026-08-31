// Our own number pad. The system keypad on iOS has no "/" key, so fractions would be
// impossible on it, and the full text keyboard covers the bottom of the screen —
// which is exactly where the plate lives. Built once, reused for targets later.

import { panel } from './sheet.js';
import { esc } from './util.js';

// "3" -> 3   "0.75" -> 0.75   "1/4" -> 0.25   "1 1/2" -> 1.5
// Anything else -> null, which the caller must treat as "not a number yet".
export function parseQty(text) {
  const s = String(text).trim();
  if (!s) return null;

  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); // mixed number
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : null;

  m = s.match(/^(\d+)\/(\d+)$/); // plain fraction
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;

  if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);
  return null;
}

// Two decimals: 1/3 becomes 0.33. That's a 0.1% error on an eyeballed dining-hall
// portion, and it keeps totals free of floating-point tails.
export const round2 = (n) => Math.round(n * 100) / 100;

const PRESETS = [
  ['¼', '1/4'], ['⅓', '1/3'], ['½', '1/2'], ['⅔', '2/3'],
  ['¾', '3/4'], ['1', '1'], ['2', '2'],
];

const KEYS = ['1', '2', '3', '/', '4', '5', '6', '.', '7', '8', '9', 'back'];

export function openKeypad({ title, subtitle, initial, onDone }) {
  let buf = '';

  // A number is either a fraction or a decimal, never both. Once you commit to one,
  // the other key is visibly dead rather than silently ignored.
  const blocked = (k) =>
    (k === '/' && (buf === '' || buf.includes('/') || buf.includes('.'))) ||
    (k === '.' && (buf.includes('.') || buf.includes('/')));

  const html = () => {
    const value = parseQty(buf);
    const shown = buf || String(initial ?? '');
    // "= 0.25" only earns its place when the conversion is doing work.
    const preview = buf
      ? (value == null
          ? `<span class="pad-bad">${esc(buf)}</span>`
          : buf.includes('/')
            ? `${esc(buf)} <span class="pad-eq">=</span> ${round2(value)}`
            : esc(buf))
      : `<span class="pad-dim">${esc(shown)}</span>`;

    return `
      <p class="pad-sub">${esc(subtitle || '')}</p>
      <div class="pad-view">${preview}</div>
      <div class="pad-presets">
        ${PRESETS.map(([label, v]) => `<button data-preset="${v}">${label}</button>`).join('')}
      </div>
      <div class="pad-grid">
        ${KEYS.map((k) => k === 'back'
          ? '<button data-key="back" aria-label="Backspace">⌫</button>'
          : `<button data-key="${k}"${blocked(k) ? ' class="off" aria-disabled="true"' : ''}>${k}</button>`).join('')}
        <button class="wide" data-key="0">0</button>
        <button class="wide go${parseQty(buf) == null && buf ? ' off' : ''}" data-done>Done</button>
      </div>`;
  };

  const update = panel({
    title,
    html: html(),
    onClick: (e) => {
      const preset = e.target.closest('[data-preset]');
      if (preset) { onDone(round2(parseQty(preset.dataset.preset))); return; }

      if (e.target.closest('[data-done]')) {
        const v = buf ? parseQty(buf) : initial;
        if (v == null) return;      // nonsense like "1/" — ignore rather than guess
        onDone(round2(v));
        return;
      }

      const key = e.target.closest('[data-key]');
      if (!key) return;
      const k = key.dataset.key;
      if (k === 'back') buf = buf.slice(0, -1);
      else if (blocked(k)) return;
      else buf += k;
      update(html());
    },
  });
}


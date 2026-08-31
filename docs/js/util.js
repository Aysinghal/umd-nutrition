// Small shared helpers. Three copies of esc() had accumulated across modules.

export const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A null is never a zero — it prints as an em dash wherever it appears.
export const num = (v, digits = 0) => (v == null ? '—' : v.toFixed(digits));

// 1, 1.5, 2 — never 1.0
export const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100));

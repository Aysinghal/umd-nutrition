// Renders a Nutrition Facts panel that FoodNoms can read off the screen.
//
// Deliberately not FDA rounding. Real labels round calories to the nearest 5 or 10 and
// fats to the nearest half gram; applying that here would make the logged numbers less
// accurate than the data we hold. Grams get one decimal, the rest are whole.

const ROWS = [
  { key: 'fat', label: 'Total Fat', unit: 'g', bold: true },
  { key: 'sat_fat', label: 'Saturated Fat', unit: 'g', indent: true },
  { key: 'trans_fat', label: 'Trans Fat', unit: 'g', indent: true },
  { key: 'chol', label: 'Cholesterol', unit: 'mg', bold: true },
  { key: 'sodium', label: 'Sodium', unit: 'mg', bold: true },
  { key: 'carbs', label: 'Total Carbohydrate', unit: 'g', bold: true },
  { key: 'fiber', label: 'Dietary Fiber', unit: 'g', indent: true },
  { key: 'sugar', label: 'Total Sugars', unit: 'g', indent: true },
  { key: 'added_sugar', label: 'Includes Added Sugars', unit: 'g', indent: 2 },
  { key: 'protein', label: 'Protein', unit: 'g', bold: true },
];

const fmt = (v, unit) => (unit === 'g' ? Math.round(v * 10) / 10 : Math.round(v));

const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function labelHtml({ name, servingSize, sums }) {
  const rows = ROWS.map((r) => {
    const cls = ['lb-row'];
    if (r.indent === 2) cls.push('lb-in2');
    else if (r.indent) cls.push('lb-in');
    const text = r.bold ? `<b>${r.label}</b>` : r.label;
    return `<div class="${cls.join(' ')}"><span>${text}</span><span>${fmt(sums[r.key] || 0, r.unit)} ${r.unit}</span></div>`;
  }).join('');

  return `<div class="lb">
    <div class="lb-name">${esc(name)}</div>
    <div class="lb-title">Nutrition Facts</div>
    <div class="lb-rule-thin"></div>
    <div class="lb-row"><span>1 serving per container</span></div>
    <div class="lb-row lb-serving"><span><b>Serving size</b></span><span><b>${esc(servingSize)}</b></span></div>
    <div class="lb-rule-thick"></div>
    <div class="lb-row lb-small"><span>Amount per serving</span></div>
    <div class="lb-cal"><span>Calories</span><span>${Math.round(sums.cal || 0)}</span></div>
    <div class="lb-rule-med"></div>
    ${rows}
  </div>`;
}

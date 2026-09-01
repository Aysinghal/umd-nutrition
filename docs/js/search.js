// Name matching over the menus.
//
// Plain case-insensitive substring, deliberately for now: it finds "chicken" but it
// will not connect "greens" to an item called "Kale". Measured against the real export,
// "greens" matches 4 items out of 1,586.
//
// Scope widens only when you ask. Searching every hall and every date automatically
// would leave you unable to tell whether what you found is being served tonight.

export const NEXT_SCOPE = { meal: 'halls', halls: 'dates', dates: null };

const norm = (s) => s.toLowerCase().trim();

// The current meal's rows have already been through the filters and the ranking, so
// narrowing them is only a name test.
export function narrow(rows, q) {
  const needle = norm(q);
  if (!needle) return rows;
  return rows.filter((r) => r.item.name.toLowerCase().includes(needle));
}

const gap = (a, b) => Math.abs(new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`));

// One row per item rather than per place it appears. Nutrition is a property of the
// item id, so the same dish across a week of menus is twenty rows of identical numbers.
// The occurrence kept is the one nearest the date you're on, purely to orient you.
export function wide(days, items, q, near, allow) {
  const needle = norm(q);
  if (!needle) return [];
  const hits = new Map();

  for (const { hall, date, menu } of days) {
    for (const meal of menu.meals) {
      for (const st of meal.stations) {
        for (const id of st.items) {
          const found = hits.get(id);
          if (found) {
            if (gap(date, near) < gap(found.date, near)) {
              Object.assign(found, { hall, date, meal: meal.meal, stations: [st.station] });
            }
            continue;
          }
          const item = items[id];
          if (!item || !item.name.toLowerCase().includes(needle)) continue;
          if (!allow(id, item)) continue;
          hits.set(id, { id, item, stations: [st.station], hall, date, meal: meal.meal });
        }
      }
    }
  }
  return [...hits.values()];
}

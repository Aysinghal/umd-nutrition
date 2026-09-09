// Fetching and joining the three exported JSON files. Nothing here knows about the UI.

const BASE = 'data';

async function json(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// The index is loaded once at boot. Remembering it here means a sheet can ask how
// old the data is without the answer being threaded through the whole UI.
let lastIndex = null;

export const loadIndex = async () => { lastIndex = await json('index.json'); return lastIndex; };
export const loadItems = () => json('items.json');

// Whole days between the export and today. Offline, the app keeps serving the last
// export it managed to download, so this is the only honest freshness signal there is.
export function dataAgeDays() {
  if (!lastIndex) return null;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(new Date()) - midnight(new Date(lastIndex.generated_at))) / 86400000);
}

// Switching back and forth between halls shouldn't refetch. Menu days are ~8 KB and
// there are at most 21 of them.
const menus = new Map();

export function loadMenu(hall, date) {
  const key = `${hall}-${date}`;
  if (!menus.has(key)) menus.set(key, json(`menu/${key}.json`));
  return menus.get(key);
}

// A day that fails to load shouldn't take a whole search down with it, so failures are
// dropped rather than rejected.
export async function loadMenus(days) {
  const out = await Promise.allSettled(days.map(async (d) => ({
    hall: d.hall, date: d.date, menu: await loadMenu(d.hall, d.date),
  })));
  return out.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// The menu file lists meals alphabetically; index.json lists them in the order they
// actually happen. Always ask the index.
export function mealsFor(index, hall, date) {
  const day = index.days.find((d) => d.hall === hall && d.date === date);
  return day ? day.meals : [];
}

// When a hall serves a meal, as UMD publishes it: "7am-10:30am", or "Closed".
//
// A missing key means we don't know -- older exports have no hours at all, and the
// sheet can simply not cover a day. That is never rendered as "closed": no note is
// better than a wrong one when the answer decides whether you walk across campus.
export function mealHours(index, hall, date, meal) {
  const day = index.days.find((d) => d.hall === hall && d.date === date);
  const raw = day && day.hours ? day.hours[meal] : null;
  if (!raw) return null;
  // UMD writes "4pm-9pm"; the spaced dash just reads better at a glance. Their
  // times are left exactly as written -- "7am" is their wording, not "7:00am".
  return raw === 'Closed' ? 'Closed' : raw.replace('-', ' – ');
}

const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

function minutes(text) {
  const m = TIME.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const pm = m[3].toLowerCase() === 'pm';
  if (pm && hour !== 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  return hour * 60 + Number(m[2] || 0);
}

// One line for the whole day: when the hall opens to when it shuts.
//
// During term the meal windows run back to back -- breakfast ends at 10:30 and
// lunch starts at 10:30 -- so they collapse into a single range. In summer they
// don't: South Campus serves lunch to 1:30pm and dinner from 5:30pm, and printing
// "11am - 6:30pm" would send you across campus to a locked door. So a real gap
// survives, and both windows are printed.
//
// Asking the day rather than the current meal is what makes this work on a
// weekend, when one hall is serving Brunch and another is serving Lunch.
//
// UMD's own wording is kept rather than re-rendered: "7am" stays "7am".
export function hallDayHours(index, hall, date) {
  const day = index.days.find((d) => d.hall === hall && d.date === date);
  const values = day && day.hours ? Object.values(day.hours) : [];
  if (!values.length) return null;

  const spans = [];
  for (const value of values) {
    const at = String(value).indexOf('-');
    // No dash means "Closed", or "TBD" on a date UMD has not settled yet.
    if (at < 0) continue;
    const from = String(value).slice(0, at).trim();
    const to = String(value).slice(at + 1).trim();
    const start = minutes(from);
    const end = minutes(to);
    if (start === null || end === null) continue;
    spans.push({ start, end, from, to });
  }
  // Closed is an answer; anything else unreadable is not, and says nothing.
  if (!spans.length) return values.includes('Closed') ? 'Closed' : null;

  spans.sort((a, b) => a.start - b.start);
  const merged = [spans[0]];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (span.start > last.end) merged.push(span);
    else if (span.end > last.end) { last.end = span.end; last.to = span.to; }
  }
  return merged.map((s) => `${s.from} – ${s.to}`).join(', ');
}

export function hasDay(index, hall, date) {
  return index.days.some((d) => d.hall === hall && d.date === date && d.status === 'ok');
}

// Everything personal lives here. One key, one object, one version number, so a
// backup/restore button later has a single thing to hand around.
//
// Writes are wrapped because storage can genuinely be unavailable — Safari private
// browsing throws on setItem, and a full disk throws QuotaExceededError. Losing a
// preference is not worth taking the app down for.

const KEY = 'umd-nutrition';
const VERSION = 1;

const DEFAULTS = {
  v: VERSION,
  hall: 19,
  level: 4,
  plate: [],
  estimates: {},   // legacy; migrated into `overrides` on first read
  overrides: {},   // itemId -> { values, source, basis, at } you supplied yourself
  sort: 'ratio',
  floor: 10,
  avoid: [],       // allergen names to exclude
  showFlagged: false,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    // Unknown future version: keep the defaults rather than guess at the shape.
    if (saved.v !== VERSION) return { ...DEFAULTS };
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

const data = load();

export const get = (key) => data[key];

export function set(key, value) {
  data[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Preference won't survive a reload. Not worth interrupting the meal over.
  }
}

// Asks the browser not to evict us under storage pressure. Chrome and Firefox honour
// it; Safari mostly ignores it. Bonus, not a guarantee — the backup button is the plan.
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

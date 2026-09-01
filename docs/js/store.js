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
  targets: {},      // macro -> { value, on }; empty falls back to DEFAULT_TARGETS
  lastBackup: null, // ISO date of the last export
  meal: null,      // last meal shown; re-guessed from the clock once it goes stale
  mealAt: 0,       // epoch ms the meal was last set
  sort: 'ratio',
  floor: 10,
  avoid: [],       // allergen names to exclude
  favorites: [],   // item ids pinned above the ranked list
  hidden: [],      // item ids kept out of the list entirely
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
// Backup works on the whole object rather than a list of fields, so anything added
// later — favourites, hidden items, saved plates — is covered without touching this.
export const snapshot = () => ({ ...data });

export function replaceAll(next) {
  if (!next || typeof next !== 'object') throw new Error('not a backup file');
  if (next.v !== VERSION) throw new Error(`backup is version ${next.v}, this app reads ${VERSION}`);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

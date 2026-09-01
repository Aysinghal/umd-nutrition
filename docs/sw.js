// Makes the app open with no signal.
//
// Two caches, deliberately. The shell is stamped with VERSION, so shipping a new
// version replaces it wholesale. The data cache is NOT stamped, so shipping a new
// version doesn't throw away the week of menus you're standing in a basement
// relying on.
//
// Bump VERSION whenever anything in SHELL_FILES changes.

const VERSION = 9;
const SHELL = `umd-shell-v${VERSION}`;
const DATA = 'umd-data';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'js/app.js',
  'js/backup.js',
  'js/data.js',
  'js/detail.js',
  'js/drag.js',
  'js/filters.js',
  'js/keypad.js',
  'js/label.js',
  'js/marks.js',
  'js/overrides.js',
  'js/plate.js',
  'js/settings.js',
  'js/sheet.js',
  'js/store.js',
  'js/suggest.js',
  'js/util.js',
];

const abs = (p) => new URL(p, self.location.href).href;

// Not a real file. A place in the data cache to write down which export we last
// pulled, so a sync can tell "nothing new" from "never fetched" without guessing.
const STAMP = abs('data/.stamp');

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL && n !== DATA).map((n) => caches.delete(n)));
    await self.clients.claim();
    // Offline on activate is normal and fine — the next open tries again.
    await sync().catch(() => {});
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'sync') e.waitUntil(sync().catch(() => {}));
});

// --- serving -----------------------------------------------------------------

// Cache first, everywhere. Opening instantly matters more than catching a menu edit
// that happened since the last open; sync() below picks that up in the background.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A reload of any in-app URL is still the one page.
  const key = req.mode === 'navigate' ? abs('index.html') : req.url;
  const bucket = url.pathname.includes('/data/') ? DATA : SHELL;

  e.respondWith((async () => {
    const cache = await caches.open(bucket);
    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      const res = await fetch(req);
      if (res.ok) await cache.put(key, res.clone());
      return res;
    } catch {
      return new Response('offline and not cached', { status: 504 });
    }
  })());
});

// --- refreshing --------------------------------------------------------------

// Pulls the whole export down, not just the day being viewed: all 21 menu files are
// 158 KB together, and having them means any hall on any day works with no signal.
//
// The index is small, so it's fetched every time as the cheap question "is there
// anything new?". Everything else only moves when the answer is yes.
async function sync() {
  const cache = await caches.open(DATA);

  const res = await fetch(abs('data/index.json'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`index.json: ${res.status}`);
  const index = await res.clone().json();
  await cache.put(abs('data/index.json'), res);

  const was = await cache.match(STAMP);
  const stamp = was ? await was.text() : null;
  const fresh = stamp !== index.generated_at;

  const menus = index.days.map((d) => `data/menu/${d.hall}-${d.date}.json`);
  const wanted = [...menus, 'data/items.json'];

  const got = await Promise.all(wanted.map(async (p) => {
    // Unchanged export and already held: nothing to do. This is the common path —
    // most opens cost one 2 KB index fetch and no more.
    if (!fresh && (await cache.match(abs(p)))) return true;
    const r = await fetch(abs(p), { cache: 'no-store' });
    if (r.ok) await cache.put(abs(p), r);
    return r.ok;
  }));

  // The export holds a rolling window, so days fall off the back. Drop them rather
  // than carrying every menu ever seen.
  const keep = new Set(wanted.map(abs));
  for (const k of await cache.keys()) {
    if (k.url.includes('/data/menu/') && !keep.has(k.url)) await cache.delete(k);
  }

  // Only claim this export is fully held once every piece of it actually is. A single
  // missing file would otherwise be written off as done and never retried.
  const complete = got.every(Boolean);
  if (complete) await cache.put(STAMP, new Response(index.generated_at));
  return { updated: fresh, complete, generated_at: index.generated_at };
}

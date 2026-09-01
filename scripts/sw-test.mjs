// Drives docs/sw.js for real: stubbed caches + fetch, but the file list and the JSON
// come off disk, so a shell file missing from the precache list fails the run.
//
//   node scripts/sw-test.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const BASE = 'https://aysinghal.github.io/umd-nutrition/';

// --- a fake network, backed by the real docs/ tree ----------------------------

const files = new Map();
function serve(rel) {
  const disk = join(DOCS, rel);
  if (existsSync(disk)) files.set(BASE + rel, readFileSync(disk, 'utf8'));
}
serve('index.html');
files.set(BASE, files.get(BASE + 'index.html'));
serve('manifest.webmanifest');
serve('css/app.css');
for (const f of ['icon-180.png', 'icon-192.png', 'icon-512.png']) files.set(BASE + f, 'PNG');
for (const f of readdirSync(join(DOCS, 'js'))) serve(`js/${f}`);
serve('data/index.json');
serve('data/items.json');
for (const f of readdirSync(join(DOCS, 'data/menu'))) serve(`data/menu/${f}`);

let online = true;
let log = [];
const urlOf = (i) => (typeof i === 'string' ? i : i.url);

async function fakeFetch(input) {
  const url = urlOf(input);
  log.push(url.replace(BASE, ''));
  if (!online) throw new TypeError('Failed to fetch');
  if (!files.has(url)) return new Response('nope', { status: 404 });
  return new Response(files.get(url), { status: 200 });
}

// --- a fake CacheStorage ------------------------------------------------------

class FakeCache {
  constructor() { this.m = new Map(); }
  async put(k, v) { this.m.set(urlOf(k), { body: await v.text(), status: v.status }); }
  async match(k) {
    const e = this.m.get(urlOf(k));
    return e ? new Response(e.body, { status: e.status }) : undefined;
  }
  async delete(k) { return this.m.delete(urlOf(k)); }
  async keys() { return [...this.m.keys()].map((url) => ({ url })); }
  async addAll(list) {
    for (const p of list) {
      const u = new URL(p, BASE).href;
      const r = await fakeFetch(u);
      if (!r.ok) throw new Error(`addAll 404: ${p}`);
      await this.put(u, r);
    }
  }
}

const store = new Map();
const caches = {
  async open(n) { if (!store.has(n)) store.set(n, new FakeCache()); return store.get(n); },
  async keys() { return [...store.keys()]; },
  async delete(n) { return store.delete(n); },
};

// --- load sw.js into a worker-ish global --------------------------------------

const listeners = {};
const sandbox = {
  caches, fetch: fakeFetch, Response, URL, JSON, Promise, Set, Map, Error, TypeError, console,
  self: null,
};
sandbox.self = {
  location: { href: `${BASE}sw.js`, origin: 'https://aysinghal.github.io' },
  addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  skipWaiting: async () => {},
  clients: { claim: async () => {} },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(DOCS, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });

async function fire(type, extra = {}) {
  const waits = [];
  const e = { waitUntil: (p) => waits.push(p), ...extra };
  for (const fn of listeners[type] || []) fn(e);
  await Promise.all(waits);
}

async function req(rel, mode = 'no-cors') {
  let out;
  await fire('fetch', {
    request: { url: rel.startsWith('http') ? rel : BASE + rel, method: 'GET', mode },
    respondWith: (p) => { out = p; },
  });
  return out;
}

// --- assertions ---------------------------------------------------------------

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
};
const shellKeys = () => [...store.get('umd-shell-v8').m.keys()].map((u) => u.replace(BASE, ''));
// 'keep-me' is a sentinel the activate test plants to prove a version bump doesn't
// wipe the data cache. It isn't real content, so counts exclude it.
const dataKeys = () => [...store.get('umd-data').m.keys()]
  .filter((u) => u !== 'keep-me').map((u) => u.replace(BASE, ''));

// --- the run ------------------------------------------------------------------

console.log('\ninstall');
try { await fire('install'); ok('precache succeeds (every listed file exists)', true); }
catch (err) { ok('precache succeeds (every listed file exists)', false, err.message); }

const onDisk = readdirSync(join(DOCS, 'js')).map((f) => `js/${f}`);
const cached = shellKeys();
const missed = onDisk.filter((f) => !cached.includes(f));
ok(`all ${onDisk.length} js modules are in the precache list`, missed.length === 0, missed.join(', '));
ok('shell cache holds 22 entries', cached.length === 22, `got ${cached.length}`);

console.log('\noffline, shell');
online = false;
ok('navigation serves index.html', (await (await req('some/deep/path', 'navigate')).text()).includes('<title>UMD Nutrition</title>'));
ok('app.js served from cache', (await (await req('js/app.js'))).status === 200);
ok('app.css served from cache', (await (await req('css/app.css'))).status === 200);
ok('uncached + offline gives 504, not a throw', (await (await req('js/nope.js'))).status === 504);
online = true;

console.log('\nactivate');
store.set('umd-shell-v7', new FakeCache());
(await caches.open('umd-data')).m.set('keep-me', { body: 'x', status: 200 });
log = [];
await fire('activate');
ok('old shell version deleted', !store.has('umd-shell-v7'));
ok('current shell kept', store.has('umd-shell-v8'));
ok('data cache survives a version bump', (await caches.open('umd-data')).m.has('keep-me'));

console.log('\nfirst sync');
ok('fetched index.json', log.includes('data/index.json'));
ok('fetched items.json', log.includes('data/items.json'));
const menuCount = log.filter((u) => u.startsWith('data/menu/')).length;
ok('fetched all 21 menu days', menuCount === 21, `got ${menuCount}`);
ok('data cache holds index + items + 21 menus + stamp', dataKeys().length === 24, `got ${dataKeys().length}`);

console.log('\nsecond sync, nothing changed');
log = [];
await fire('message', { data: { type: 'sync' } });
ok('re-checks the index', log.includes('data/index.json'));
ok('re-downloads nothing else', log.length === 1, `fetched ${log.length}: ${log.join(', ')}`);

console.log('\nnew export lands');
const idx = JSON.parse(files.get(`${BASE}data/index.json`));
idx.generated_at = '2026-09-01T09:00:00';
files.set(`${BASE}data/index.json`, JSON.stringify(idx));
log = [];
await fire('message', { data: { type: 'sync' } });
ok('re-downloads items.json', log.includes('data/items.json'));
ok('re-downloads all 21 menus', log.filter((u) => u.startsWith('data/menu/')).length === 21);

console.log('\na day falls off the back of the window');
const dropped = idx.days.filter((d) => d.date === '2026-08-31');
idx.days = idx.days.filter((d) => d.date !== '2026-08-31');
idx.generated_at = '2026-09-02T09:00:00';
files.set(`${BASE}data/index.json`, JSON.stringify(idx));
await fire('message', { data: { type: 'sync' } });
const gone = dropped.every((d) => !dataKeys().includes(`data/menu/${d.hall}-${d.date}.json`));
ok(`pruned the ${dropped.length} menu files for 2026-08-31`, gone);
ok('kept the other 18', dataKeys().filter((k) => k.startsWith('data/menu/')).length === 18,
  `got ${dataKeys().filter((k) => k.startsWith('data/menu/')).length}`);

console.log('\noffline');
online = false;
let threw = false;
try { await fire('message', { data: { type: 'sync' } }); } catch { threw = true; }
ok('a failed sync is swallowed, not thrown at the page', !threw);
ok('cached data survives a failed sync', dataKeys().length === 21, `got ${dataKeys().length}`);
const menu = await req('data/menu/19-2026-09-01.json');
ok('menu still served with no network', menu.status === 200);
ok('menu body is real json', Array.isArray((JSON.parse(await menu.text())).meals));
const items = await req('data/items.json');
ok('items.json still served with no network', items.status === 200);
online = true;


console.log('\na file is missing from the export');
const victim = `${BASE}data/menu/51-2026-09-06.json`;
const saved = files.get(victim);
files.delete(victim);
idx.generated_at = '2026-09-03T09:00:00';
files.set(`${BASE}data/index.json`, JSON.stringify(idx));
await fire('message', { data: { type: 'sync' } });
ok('a 404 on one file does not take the sync down', dataKeys().includes('data/items.json'));
files.set(victim, saved);
log = [];
await fire('message', { data: { type: 'sync' } });
ok('an incomplete export is retried next sync, not written off',
  log.includes('data/menu/51-2026-09-06.json'));
ok('the retry completes it', dataKeys().includes('data/menu/51-2026-09-06.json'));
log = [];
await fire('message', { data: { type: 'sync' } });
ok('then it settles back to one index fetch', log.length === 1, `fetched ${log.length}`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

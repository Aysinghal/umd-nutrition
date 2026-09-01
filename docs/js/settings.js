// One sheet for everything you can change: what the list shows, your targets, backup.

import { panel } from './sheet.js';
import { openKeypad } from './keypad.js';
import * as plate from './plate.js';
import * as backup from './backup.js';
import * as store from './store.js';
import { SORTS, ALLERGENS, get as getFilters, reset as resetFilters } from './filters.js';
import { dataAgeDays } from './data.js';
import { esc } from './util.js';

let notify = null;

export function openSettings(onChange) {
  notify = onChange;
  draw();
}

function ageLine() {
  const { days, stale } = backup.backupAge();
  const text = days == null
    ? 'never backed up'
    : days === 0 ? 'backed up today' : `last backed up ${days} day${days === 1 ? '' : 's'} ago`;
  return `<span class="${stale ? 'set-stale' : 'set-ok'}">${text}</span>`;
}

// The app runs off a copy on the phone, so "how old is that copy" is a real question
// with a real answer, not a detail.
function offlineLine() {
  const days = dataAgeDays();
  if (days == null) return '<span class="set-stale">no menu data yet</span>';
  if (days <= 0) return '<span class="set-ok">menu data is from today</span>';
  return `<span class="set-stale">menu data is ${days} day${days === 1 ? '' : 's'} old</span>`;
}

function draw() {
  const f = getFilters();
  const t = plate.targets();

  panel({
    title: 'Settings',
    html: `
      <p class="f-head">Sort by</p>
      <div class="f-chips">
        ${Object.entries(SORTS).map(([k, label]) =>
          `<button class="f-chip${f.sort === k ? ' on' : ''}" data-sort="${k}">${label}</button>`).join('')}
      </div>

      <button class="fill-row" data-floor>
        <span>Minimum protein<span class="d-was">ranks below this, never hidden</span></span>
        <span class="fill-v">${f.floor} g</span>
      </button>

      <p class="f-head">Avoid</p>
      <div class="f-chips">
        ${ALLERGENS.map(([name, n]) =>
          `<button class="f-chip${f.avoid.includes(name) ? ' on' : ''}" data-avoid="${name}">${name}
            <span class="f-n">${n}</span></button>`).join('')}
      </div>
      <p class="f-note">Hides items that declare it. Not reliable for a real allergy.</p>

      <div class="set-row">
        <span class="set-label">Show flagged items<span class="d-was">29 items whose numbers can't be true</span></span>
        <button class="sw-btn${f.showFlagged ? ' on' : ''}" data-flagged
          aria-pressed="${f.showFlagged}" aria-label="Show flagged items">
          <span class="sw" aria-hidden="true"><span class="knob"></span></span>
        </button>
      </div>

      <p class="f-head">Targets, per meal</p>
      ${plate.MACROS.map((m) => `
        <div class="set-row">
          <button class="set-val" data-edit="${m}">
            <span>${plate.LABELS[m]}</span>
            <span class="fill-v">${t[m].value}${plate.UNITS[m] ? ` ${plate.UNITS[m]}` : ''}</span>
          </button>
          <button class="sw-btn${t[m].on ? ' on' : ''}" data-toggle="${m}"
            aria-pressed="${t[m].on}" aria-label="${plate.LABELS[m]} target on">
            <span class="sw" aria-hidden="true"><span class="knob"></span></span>
          </button>
        </div>`).join('')}
      <p class="f-note">On gets a bar you are measured against. Off just shows the number.</p>

      <p class="f-head">Backup</p>
      <p class="set-age">${ageLine()}</p>
      <button class="go set-wide" data-save>Back up now</button>
      <button class="fill-row set-wide" data-load>
        <span>Restore from a file</span>
      </button>
      <input type="file" id="set-file" accept="application/json,.json" hidden>

      <p class="f-head">Offline</p>
      <p class="set-age">${offlineLine()}</p>
      <button class="fill-row set-wide" data-refresh>
        <span>Reload &amp; update<span class="d-was">throws away the downloaded copy and fetches it again</span></span>
      </button>

      <div class="panel-actions"><button class="danger" data-reset>Reset filters</button></div>`,
    onClick: handle,
  });
}

function handle(e) {
  const sort = e.target.closest('[data-sort]');
  const avoid = e.target.closest('[data-avoid]');
  const edit = e.target.closest('[data-edit]');
  const toggle = e.target.closest('[data-toggle]');

  if (sort) store.set('sort', sort.dataset.sort);
  else if (avoid) {
    const name = avoid.dataset.avoid;
    const list = store.get('avoid') || [];
    store.set('avoid', list.includes(name) ? list.filter((a) => a !== name) : [...list, name]);
  } else if (e.target.closest('[data-flagged]')) store.set('showFlagged', !store.get('showFlagged'));
  else if (e.target.closest('[data-reset]')) resetFilters();
  else if (toggle) {
    const m = toggle.dataset.toggle;
    plate.setTarget(m, { on: !plate.targets()[m].on });
  } else if (e.target.closest('[data-refresh]')) {
    return confirmRefresh();
  } else if (e.target.closest('[data-floor]')) {
    return openKeypad({
      title: 'Minimum protein',
      subtitle: 'items below this rank under the divider',
      initial: store.get('floor'),
      onDone: (v) => { store.set('floor', v); notify?.(); draw(); },
    });
  } else if (edit) {
    const m = edit.dataset.edit;
    return openKeypad({
      title: `${plate.LABELS[m]} target`,
      subtitle: 'per meal, not per day',
      initial: plate.targets()[m].value,
      onDone: (v) => { plate.setTarget(m, { value: v }); notify?.(); draw(); },
    });
  } else if (e.target.closest('[data-save]')) {
    backup.save().then((how) => { if (how !== 'cancelled') draw(); });
    return;
  } else if (e.target.closest('[data-load]')) {
    const input = document.getElementById('set-file');
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) confirmRestore(file);
      input.value = '';
    };
    input.click();
    return;
  } else return;

  notify?.();
  draw();
}

// The escape hatch for a wedged worker. Done from the page rather than by asking the
// worker to clear itself, because the case this exists for is the worker not answering.
function confirmRefresh() {
  panel({
    title: 'Reload & update',
    html: `
      <p class="pad-sub">Deletes the copy of the app and menus stored on this phone and
        downloads them again. Needs a connection.</p>
      <p class="pad-sub">Your plate, targets, overrides and settings are stored separately
        and are not touched.</p>
      <div class="fill-actions">
        <button data-cancel>Cancel</button>
        <button class="go" data-confirm>Reload</button>
      </div>`,
    onClick: async (e) => {
      if (e.target.closest('[data-cancel]')) return draw();
      if (!e.target.closest('[data-confirm]')) return;
      try {
        const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
        const names = await self.caches?.keys?.() ?? [];
        await Promise.all(names.map((n) => self.caches.delete(n)));
      } catch {
        // Nothing cached is exactly the state we were trying to reach.
      }
      location.reload();
    },
  });
}

// Never overwrite silently — say what is in the file first.
function confirmRestore(file) {
  backup.read(file).then((data) => {
    panel({
      title: 'Restore this backup?',
      html: `
        <p class="pad-sub">${esc(file.name)}</p>
        <ul class="set-list">${backup.describe(data).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p class="d-warn">This replaces everything on this device. The page will reload.</p>
        <div class="fill-actions">
          <button data-cancel>Cancel</button>
          <button class="go" data-confirm>Restore</button>
        </div>`,
      onClick: (e) => {
        if (e.target.closest('[data-cancel]')) return draw();
        if (!e.target.closest('[data-confirm]')) return;
        try {
          backup.restore(data);
          location.reload();
        } catch (err) {
          fail(err.message);
        }
      },
    });
  }).catch((err) => fail(err.message));
}

function fail(message) {
  panel({
    title: 'Could not restore',
    html: `<p class="d-warn">${esc(message)}</p>
      <div class="fill-actions"><button class="go" data-back>Back</button></div>`,
    onClick: () => draw(),
  });
}

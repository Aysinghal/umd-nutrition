// Targets, backup and restore.

import { panel } from './sheet.js';
import { openKeypad } from './keypad.js';
import * as plate from './plate.js';
import * as backup from './backup.js';
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

function draw() {
  const t = plate.targets();

  panel({
    title: 'Settings',
    html: `
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
      <p class="f-note">A target that is on gets a bar you are measured against. Off means
        the number still shows, without judgement.</p>

      <p class="f-head">Backup</p>
      <p class="set-age">${ageLine()}</p>
      <button class="go set-wide" data-save>Back up now</button>
      <button class="fill-row set-wide" data-load>
        <span>Restore from a file<span class="d-was">replaces everything on this device</span></span>
      </button>
      <input type="file" id="set-file" accept="application/json,.json" hidden>
      <p class="f-note">No app can write to your Files automatically on an iPhone, so this
        is one tap when you think of it. Installing to the Home Screen is what protects
        the data day to day.</p>`,
    onClick: handle,
  });
}

function handle(e) {
  const edit = e.target.closest('[data-edit]');
  const toggle = e.target.closest('[data-toggle]');

  if (edit) {
    const m = edit.dataset.edit;
    return openKeypad({
      title: `${plate.LABELS[m]} target`,
      subtitle: 'per meal, not per day',
      initial: plate.targets()[m].value,
      onDone: (v) => { plate.setTarget(m, { value: v }); notify?.(); draw(); },
    });
  }

  if (toggle) {
    const m = toggle.dataset.toggle;
    plate.setTarget(m, { on: !plate.targets()[m].on });
    notify?.();
    return draw();
  }

  if (e.target.closest('[data-save]')) {
    backup.save().then((how) => { if (how !== 'cancelled') draw(); });
    return;
  }

  if (e.target.closest('[data-load]')) {
    const input = document.getElementById('set-file');
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) confirmRestore(file);
      input.value = '';
    };
    input.click();
  }
}

// Never overwrite silently — say what is in the file first.
function confirmRestore(file) {
  backup.read(file).then((data) => {
    panel({
      title: 'Restore this backup?',
      html: `
        <p class="pad-sub">${esc(file.name)}</p>
        <ul class="set-list">${backup.describe(data).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p class="d-warn">This replaces everything currently on this device. The page will
          reload.</p>
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
          panel({
            title: 'Could not restore',
            html: `<p class="d-warn">${esc(err.message)}</p>
              <div class="fill-actions"><button class="go" data-cancel>Back</button></div>`,
            onClick: () => draw(),
          });
        }
      },
    });
  }).catch((err) => {
    panel({
      title: 'Could not read that file',
      html: `<p class="d-warn">${esc(err.message)}</p>
        <div class="fill-actions"><button class="go" data-cancel>Back</button></div>`,
      onClick: () => draw(),
    });
  });
}

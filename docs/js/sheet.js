// The slide-up panel. Built once, reused by every sheet in the app.

import { draggable } from './drag.js';
import { esc } from './util.js';

let root = null;
let onClose = null;
let drag = null;
let lockedAt = 0;

function lockPage() {
  lockedAt = window.scrollY;
  document.body.style.top = `${-lockedAt}px`;
  document.body.classList.add('sheet-open');
}

function unlockPage() {
  document.body.classList.remove('sheet-open');
  document.body.style.top = '';
  window.scrollTo(0, lockedAt);
}

function build() {
  root = document.createElement('div');
  root.className = 'sheet-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="sheet-back" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-head" data-close>
        <div class="sheet-grab"></div>
      </div>
      <div class="sheet-titlerow">
        <h2 class="sheet-title" id="sheet-title"></h2>
      </div>
      <div class="sheet-body"></div>
      <div class="sheet-foot">
        <button class="sheet-close" data-close>Close</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });

  // The sheet scrolls, so the drag only takes over at the top of its content —
  // except from the handle, which always grabs it.
  drag = draggable(root.querySelector('.sheet'), {
    scroller: root.querySelector('.sheet-body'),
    handle: '.sheet-head, .sheet-titlerow, .sheet-foot',
    onClose: close,
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) close();
  });
}

export function close() {
  if (!root || root.hidden) return;
  drag?.reset();
  root.hidden = true;
  unlockPage();
  const fn = onClose;
  onClose = null;
  fn?.();
}

// options: [{ value, label, note }]
export function pick({ title, options, current, onPick }) {
  if (!root) build();

  root.querySelector('.sheet-title').textContent = title;
  const body = root.querySelector('.sheet-body');
  body.innerHTML = options
    .map((o) => {
      const on = o.value === current;
      // Escaped because notes now carry hours, and those come out of a Google
      // Sheet other people edit rather than a string this app wrote.
      return `<button class="opt${on ? ' on' : ''}" data-value="${esc(o.value)}"${on ? ' aria-current="true"' : ''}>
        <span class="opt-label">${esc(o.label)}</span>
        ${o.note ? `<span class="opt-note">${esc(o.note)}</span>` : ''}
      </button>`;
    })
    .join('');

  body.onclick = (e) => {
    const btn = e.target.closest('.opt');
    if (!btn) return;
    const raw = btn.dataset.value;
    close();
    // Values arrive as strings from the DOM; hand back the original typed value.
    onPick(options.find((o) => String(o.value) === raw).value);
  };

  drag?.reset();
  const wasOpen = !root.hidden;
  root.hidden = false;
  if (!wasOpen) lockPage();
  root.querySelector('.opt.on, .opt')?.focus();
}

// Free-form sheet, for content that isn't a list of choices. Returns a function that
// swaps the body without reopening, so steppers can update in place.
export function panel({ title, html, onClick }) {
  if (!root) build();

  root.querySelector('.sheet-title').textContent = title;
  const body = root.querySelector('.sheet-body');
  body.innerHTML = html;
  body.onclick = onClick || null;

  drag?.reset();
  const wasOpen = !root.hidden;
  root.hidden = false;
  if (!wasOpen) lockPage();

  return (nextHtml) => {
    if (!root.hidden) body.innerHTML = nextHtml;
  };
}

export const isOpen = () => root && !root.hidden;

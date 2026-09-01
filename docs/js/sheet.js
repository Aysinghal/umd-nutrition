// The slide-up panel. Built once, reused by every sheet in the app.

import { draggable } from './drag.js';

let root = null;
let onClose = null;
let drag = null;

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
        <button class="sheet-close" data-close aria-label="Close">✕</button>
      </div>
      <div class="sheet-body"></div>
    </div>`;
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });

  // The sheet scrolls, so the drag only takes over at the top of its content —
  // except from the handle, which always grabs it.
  drag = draggable(root.querySelector('.sheet'), {
    scroller: root.querySelector('.sheet-body'),
    handle: '.sheet-head, .sheet-titlerow',
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
  document.body.classList.remove('sheet-open');
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
      return `<button class="opt${on ? ' on' : ''}" data-value="${o.value}"${on ? ' aria-current="true"' : ''}>
        <span class="opt-label">${o.label}</span>
        ${o.note ? `<span class="opt-note">${o.note}</span>` : ''}
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
  root.hidden = false;
  document.body.classList.add('sheet-open');
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
  root.hidden = false;
  document.body.classList.add('sheet-open');

  return (nextHtml) => {
    if (!root.hidden) body.innerHTML = nextHtml;
  };
}

export const isOpen = () => root && !root.hidden;

// Drag-down-to-dismiss, shared by the bottom sheets and the full-screen label.
//
// The hard part is that these panels scroll. A downward drag is ambiguous: scroll the
// content, or pull the panel away? The rule is the usual one — the panel only takes the
// drag when its content is already at the top. Partway down a long item, a downward
// swipe just scrolls.

const ENGAGE = 8;      // px of movement before we decide it's a drag, not a tap
const CLOSE_FRACTION = 0.25;
const FLICK = 0.5;     // px/ms downward at release is enough on its own

export function draggable(panel, { scroller, onClose, handle }) {
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let active = false;   // pointer is down and might become a drag
  let dragging = false; // it is definitely a drag

  const top = () => (scroller ? scroller.scrollTop <= 0 : true);

  const setY = (y) => {
    panel.style.transform = y ? `translateY(${y}px)` : '';
    panel.style.transition = '';
  };

  const release = (animate = true) => {
    if (animate) panel.style.transition = 'transform .2s cubic-bezier(.2,.8,.3,1)';
    panel.style.transform = '';
    active = dragging = false;
    dy = 0;
  };

  panel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // a press that starts on a control is a tap, never a drag
    if (e.target.closest('button, input, .opt')) return;
    // A drag from the handle always grabs the panel, wherever the content is scrolled.
    // The handle is the reliable path: it never scrolls, so the browser has no
    // competing gesture. Dragging from the body only works while it sits at the top.
    const fromHandle = handle && e.target.closest(handle);
    if (!fromHandle && !top()) return;
    startY = e.clientY;
    startT = performance.now();
    active = true;
    dragging = false;
  });

  panel.addEventListener('pointermove', (e) => {
    if (!active) return;
    const delta = e.clientY - startY;

    if (!dragging) {
      if (delta < ENGAGE) {
        // Scrolled back up, or moved sideways — let the content have the gesture.
        if (delta < -2) active = false;
        return;
      }
      const fromHandle = handle && e.target.closest(handle);
      if (!fromHandle && !top()) { active = false; return; }
      dragging = true;
      panel.setPointerCapture?.(e.pointerId);
    }

    // Resist upward travel so the panel can't be flung above its resting place.
    dy = Math.max(0, delta - ENGAGE);
    setY(dy);
    e.preventDefault();
  }, { passive: false });

  const finish = (e) => {
    if (!dragging) { active = false; return; }
    const speed = dy / Math.max(1, performance.now() - startT);
    const far = dy > panel.offsetHeight * CLOSE_FRACTION;

    if (far || speed > FLICK) {
      panel.style.transition = 'transform .18s ease-in';
      panel.style.transform = `translateY(${panel.offsetHeight}px)`;
      const done = () => { release(false); onClose(); };
      panel.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 240);   // transitionend can go missing if the panel is hidden
    } else {
      release();
    }
    // Swallow the click that a drag would otherwise fire on whatever is underneath.
    if (e) e.preventDefault();
  };

  panel.addEventListener('pointerup', finish);
  panel.addEventListener('pointercancel', () => release());

  return { reset: () => release(false) };
}

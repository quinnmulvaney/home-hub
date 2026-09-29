// Horizontal swipe on list rows (touch and mouse), for lists that are re-rendered with innerHTML.
// Delegated from a persistent `root`.
//
//   swipe(root, { item: '.swipe', surface: '.swipe .row', onRight(id, wrap), onLeft(id, wrap) })
//
// Each item needs data-id. Dragging the row right past `threshold` triggers onRight, left triggers onLeft.
// The row springs back either way; the caller decides what happens next (menu, confirm dialog...).
export function swipe(root, { item, surface, onRight, onLeft, threshold = 84 }) {
  let justSwiped = false;

  root.addEventListener('pointerdown', (e) => {
    if ((e.button != null && e.button > 0) || e.isPrimary === false) return;
    const el = e.target.closest(surface);
    if (!el || !root.contains(el)) return;
    const wrap = el.closest(item);
    if (!wrap) return;

    const startX = e.clientX, startY = e.clientY;
    let dx = 0, decided = false, active = false;

    const move = (ev) => {
      const mx = ev.clientX - startX, my = ev.clientY - startY;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        active = Math.abs(mx) > Math.abs(my) * 1.4;      // mostly sideways, otherwise let the page scroll
        if (!active) { stop(); return; }
        wrap.classList.add('swiping');
        try { el.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
      }
      dx = Math.max(-160, Math.min(160, mx));
      el.style.transform = `translateX(${dx}px)`;
      wrap.dataset.dir = dx > 0 ? 'right' : 'left';
      wrap.classList.toggle('armed', Math.abs(dx) >= threshold);
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
    };
    const reset = () => {
      el.style.transform = '';
      wrap.classList.remove('swiping', 'armed');
      delete wrap.dataset.dir;
    };
    const up = () => {
      stop();
      if (!active) return;
      const fired = Math.abs(dx) >= threshold;
      const dir = dx > 0 ? 'right' : 'left';
      reset();
      justSwiped = true;                                  // swallow the click that follows a drag
      setTimeout(() => { justSwiped = false; }, 350);
      if (fired) (dir === 'right' ? onRight : onLeft)?.(wrap.dataset.id, wrap);
    };
    const cancel = () => { stop(); reset(); };

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  });

  root.addEventListener('click', (e) => {
    if (justSwiped && e.target.closest(surface)) { e.preventDefault(); e.stopPropagation(); justSwiped = false; }
  }, true);
}

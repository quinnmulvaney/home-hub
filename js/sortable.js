// Drag-and-drop reordering (mouse and touch) plus keyboard reordering, for lists that are re-rendered
// with innerHTML. Listeners sit on a persistent `root` and find lists by selector, so they survive redraws.
//
//   sortable(root, { list: '.plan-list', item: '.plan-row', handle: '.drag-handle', onDrop(ids, listEl) })
//
// Each item needs data-id. While a drag is running the page isn't asked to redraw (onStart/onEnd).
export function sortable(root, { list, item, handle, onDrop, onStart, onEnd }) {
  const idsOf = (listEl) => [...listEl.querySelectorAll(item)].map((el) => el.dataset.id);

  root.addEventListener('pointerdown', (e) => {
    const h = e.target.closest(handle);
    if (!h || !root.contains(h) || (e.button != null && e.button > 0)) return;
    const listEl = h.closest(list);
    const el = h.closest(item);
    if (!listEl || !el) return;
    e.preventDefault();

    const items = [...listEl.querySelectorAll(item)];
    const scroll0 = window.scrollY;
    const rects = items.map((x) => { const r = x.getBoundingClientRect(); return { top: r.top + scroll0, h: r.height }; });
    const from = items.indexOf(el);
    const startY = e.clientY + scroll0;
    let clientY = e.clientY, target = from, raf = 0;

    onStart?.();
    el.classList.add('dragging');
    listEl.classList.add('sorting');
    try { h.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }

    const update = () => {
      const dy = clientY + window.scrollY - startY;
      el.style.transform = `translateY(${dy}px)`;
      const center = rects[from].top + dy + rects[from].h / 2;
      target = rects.filter((r, i) => i !== from && r.top + r.h / 2 < center).length;
      items.forEach((x) => x.classList.remove('drop-before', 'drop-end'));
      const others = items.filter((_, i) => i !== from);
      if (others.length) others[Math.min(target, others.length - 1)].classList.add(target < others.length ? 'drop-before' : 'drop-end');
    };
    const tick = () => {
      if (clientY < 70) window.scrollBy(0, -12);
      else if (clientY > window.innerHeight - 70) window.scrollBy(0, 12);
      update();
      raf = requestAnimationFrame(tick);
    };
    const move = (ev) => { clientY = ev.clientY; update(); };
    const finish = (cancelled) => {
      cancelAnimationFrame(raf);
      update();
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', cancel);
      items.forEach((x) => x.classList.remove('drop-before', 'drop-end', 'dragging'));
      el.style.transform = '';
      listEl.classList.remove('sorting');
      const ids = idsOf(listEl);
      const [moved] = ids.splice(from, 1);
      ids.splice(target, 0, moved);
      onEnd?.();
      if (!cancelled && target !== from) onDrop(ids, listEl);
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', cancel);
    raf = requestAnimationFrame(tick);
  });

  // Keyboard: focus a handle, then Up/Down arrows move the item.
  root.addEventListener('keydown', (e) => {
    const h = e.target.closest?.(handle);
    if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const listEl = h.closest(list);
    const el = h.closest(item);
    if (!listEl || !el) return;
    const ids = idsOf(listEl);
    const i = ids.indexOf(el.dataset.id);
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (j < 0 || j >= ids.length) return;
    e.preventDefault();
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onDrop(ids, listEl);
  });
}

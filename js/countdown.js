// Live wedding countdown. Shared: the Home screen uses it now, and the Calendar tab can drop the same
// component in later:  el.innerHTML = countdownHtml(date);  const stop = startCountdown(el);  (call stop() on leave)
import { esc } from './util.js';

const pad = (n) => String(n).padStart(2, '0');
const startOf = (iso) => new Date(`${iso}T00:00:00`);

export function countdownHtml(dateISO, { label = 'until we say “I do”' } = {}) {
  if (!dateISO) return '';
  const nice = startOf(dateISO).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `
    <div class="cd" data-countdown="${esc(dateISO)}" role="timer" aria-label="Time until the wedding">
      <div class="cd-units">
        <div class="cd-unit"><b data-cd="d">--</b><span data-cd-label="d">days</span></div>
        <div class="cd-unit"><b data-cd="h">--</b><span>hours</span></div>
        <div class="cd-unit"><b data-cd="m">--</b><span>min</span></div>
        <div class="cd-unit"><b data-cd="s">--</b><span>sec</span></div>
      </div>
      <div class="cd-note" data-cd="note">${esc(label)}</div>
      <div class="cd-date">${esc(nice)}</div>
    </div>`;
}

// Starts ticking every `.cd` inside `root`; returns a function that stops it.
export function startCountdown(root) {
  const boxes = [...root.querySelectorAll('[data-countdown]')];
  if (!boxes.length) return () => {};
  const tick = () => {
    for (const box of boxes) {
      const target = startOf(box.dataset.countdown).getTime();
      let ms = target - Date.now();
      const set = (k, v) => { const n = box.querySelector(`[data-cd="${k}"]`); if (n && n.textContent !== String(v)) n.textContent = v; };
      if (ms <= 0) {
        // Wedding day itself, then "just married".
        const since = Math.floor(-ms / 864e5);
        const today = since === 0;
        set('d', today ? '🎉' : since);
        set('h', '--'); set('m', '--'); set('s', '--');
        const lab = box.querySelector('[data-cd-label="d"]');
        if (lab) lab.textContent = today ? 'today' : since === 1 ? 'day married' : 'days married';
        set('note', today ? 'Today is the day! 💍' : 'Just married 💍');
        continue;
      }
      const s = Math.floor(ms / 1000);
      const days = Math.floor(s / 86400);
      set('d', days);
      set('h', pad(Math.floor((s % 86400) / 3600)));
      set('m', pad(Math.floor((s % 3600) / 60)));
      set('s', pad(s % 60));
      const lab = box.querySelector('[data-cd-label="d"]');
      if (lab) lab.textContent = days === 1 ? 'day' : 'days';
    }
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

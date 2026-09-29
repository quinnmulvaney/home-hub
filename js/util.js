export function newId(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- preferences (per device) ----------

export function pref(key, fallback) {
  try { const v = localStorage.getItem(`homehub:pref:${key}`); return v === null ? fallback : v; } catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(`homehub:pref:${key}`, value); } catch {}
}

// ---------- money ----------

let fmt = null;
let fmtCurrency = null;
// Privacy: "hide amounts" masks every dollar figure (the eye button in the header and Settings → Privacy).
let hidden = false;
try { hidden = localStorage.getItem('homehub:pref:hideAmounts') === '1'; } catch { /* storage blocked */ }
export const amountsHidden = () => hidden;
const MASK = /\d[\d.,\u00a0\u202f]*/g;
export function setHideAmounts(on) {
  hidden = !!on;
  setPref('hideAmounts', hidden ? '1' : '0');
  document.documentElement.classList.toggle('hide-amounts', hidden);
  window.dispatchEvent(new Event('homehub:privacy'));
}
// Short axis labels like $1.2K (masked when amounts are hidden).
export function moneyCompact(v) {
  if (hidden) return '•••';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: pref('currency', 'USD'), notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

export function money(n, { sign = false } = {}) {
  const cur = pref('currency', 'USD');
  if (cur !== fmtCurrency) {
    fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur });
    fmtCurrency = cur;
  }
  const s0 = fmt.format(Math.abs(n || 0));
  const s = hidden ? s0.replace(MASK, '•••') : s0;
  if (n < 0) return `−${s}`;
  return sign && n > 0 ? `+${s}` : s;
}

export function parseAmount(s) {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// ---------- dates (all local, stored as YYYY-MM-DD strings) ----------

const pad = (n) => String(n).padStart(2, '0');
export const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISODate(new Date());
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export function addMonths(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

export function monthLabel(key, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
}

export function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayISO();
  const yest = toISODate(new Date(Date.now() - 864e5));
  if (iso === today) return 'Today';
  if (iso === yest) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------- UI helpers ----------

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Opens the shared <dialog>. `html` is its inner markup; returns the dialog element.
export function openModal(html) {
  const dlg = document.getElementById('modal');
  dlg.innerHTML = html;
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); }; // tap outside to close
  dlg.showModal();
  const first = dlg.querySelector('[autofocus]');
  if (first) setTimeout(() => first.focus(), 30);
  return dlg;
}

export function closeModal() {
  const dlg = document.getElementById('modal');
  if (dlg.open) dlg.close();
}

// Re-render a container without losing the focused input / caret.
export function renderKeepingFocus(el, html) {
  const active = document.activeElement;
  const key = active && el.contains(active) ? active.dataset.focusKey : null;
  const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  el.innerHTML = html;
  if (key) {
    const again = el.querySelector(`[data-focus-key="${key}"]`);
    if (again) {
      again.focus();
      if (sel) try { again.setSelectionRange(...sel); } catch {}
    }
  }
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- appearance (saved per device) ----------

export const PALETTES = [
  { id: 'wedding', name: 'Wedding', swatch: ['#4f7396', '#0f7f5f', '#b58a2a'] },
  { id: 'rose', name: 'Rose & Sage', swatch: ['#a4576b', '#4f7a5a', '#b58a2a'] },
  { id: 'sage', name: 'Sage Garden', swatch: ['#4f7a5a', '#3f7d6d', '#b0703a'] },
  { id: 'lavender', name: 'Lavender', swatch: ['#6a5bb5', '#157a6e', '#b58a2a'] },
  { id: 'classic', name: 'Classic Blue', swatch: ['#2570cc', '#0a7d3b', '#c2571f'] },
  { id: 'graphite', name: 'Graphite', swatch: ['#3d4a57', '#0f7f5f', '#8c7a2e'] },
];

// Sets the palette, light/dark, text size and contrast on <html>. index.html runs a tiny copy of this before first paint.
export function applyAppearance() {
  const h = document.documentElement;
  const saved = pref('palette', 'wedding');
  const mode = pref('mode', 'auto');
  const dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  h.dataset.palette = PALETTES.some((p) => p.id === saved) ? saved : 'wedding';
  h.dataset.mode = dark ? 'dark' : 'light';
  h.dataset.contrast = pref('contrast', '0') === '1' ? 'high' : 'normal';
  h.style.setProperty('--fs-scale', pref('textSize', '1'));
  h.classList.toggle('hide-amounts', hidden);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = getComputedStyle(h).getPropertyValue('--hero-1').trim() || '#4f7396';
}
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (pref('mode', 'auto') === 'auto') applyAppearance(); });
} catch { /* older browsers */ }

// ---------- undo bar ----------
// A bar that slides up from the bottom after a delete, offers Undo for a few seconds, then slides away.

let undoTimer;
export function toastUndo(message, onUndo, ms = 7000) {
  const bar = document.getElementById('undo-bar');
  if (!bar) { toast(message); return; }
  bar.innerHTML = '<span class="undo-msg"></span><button type="button" class="undo-btn">Undo</button>';
  bar.querySelector('.undo-msg').textContent = message;
  const hide = () => bar.classList.remove('show');
  bar.querySelector('.undo-btn').onclick = () => {
    clearTimeout(undoTimer);
    hide();
    try { onUndo(); } catch (e) { console.error(e); }
  };
  bar.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hide, ms);
}

// "Are you sure?" dialog. Resolves true only when the confirm button is pressed. `body` is HTML (escape user text first).
export function confirmDialog({ title, body = '', confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const dlg = openModal(`
      <div class="form">
        <h2>${esc(title)}</h2>
        <p>${body}</p>
        <div class="form-actions"><span class="spacer"></span>
          <button type="button" class="btn" data-c="no">Cancel</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-c="yes" autofocus>${esc(confirmLabel)}</button>
        </div>
      </div>`);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onClose = () => finish(false);
    dlg.addEventListener('close', onClose);
    dlg.querySelector('[data-c=no]').onclick = () => finish(false);
    dlg.querySelector('[data-c=yes]').onclick = () => finish(true);
  });
}

export const relTime = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  const days = Math.round(mins / 1440);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

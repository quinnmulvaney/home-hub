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
export function money(n, { sign = false } = {}) {
  const cur = pref('currency', 'USD');
  if (cur !== fmtCurrency) {
    fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur });
    fmtCurrency = cur;
  }
  const s = fmt.format(Math.abs(n || 0));
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

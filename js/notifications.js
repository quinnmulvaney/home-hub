// Notification center: the 🔔 in the header shows recent alerts (budget limits, large purchases, bills due,
// subscription price changes, weekly summaries). Entries live in the household's `notifications` collection.
// Both the app and the bank-sync job write entries with the same deterministic ids, so nothing shows twice.
import * as store from './store.js';
import { esc, openModal, closeModal, pref, setPref, relTime, confirmDialog, toast } from './util.js';

store.registerCollections(['notifications']);

const KINDS = {
  budget: '⚠️', over: '🚨', big: '💳', bill: '🗓️', price: '💸', weekly: '📊', sync: '🏦',
};

// Add an entry once (same id = same entry). `quiet` entries don't count as unread.
export function logNotification({ id, kind, title, body = '', link = '', quiet = false }) {
  if (store.getAll('notifications').some((n) => n.id === id)) return;
  store.put('notifications', id, { kind, title, body, link, quiet, ts: Date.now() });
}

const seenAt = () => Number(pref('bellSeen', '0')) || 0;
const unread = (list) => list.filter((n) => !n.quiet && (n.ts || 0) > seenAt());

export function startBell(button, badge) {
  let list = [];
  const paint = () => {
    const n = unread(list).length;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? '9+' : String(n);
    button.setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications');
  };
  store.subscribe('notifications', (l) => { list = l; paint(); });
  window.addEventListener('homehub:datasource', paint);

  button.addEventListener('click', () => {
    const sorted = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
    const lastSeen = seenAt();
    const dlg = openModal(`
      <div class="form">
        <h2>Notifications</h2>
        ${sorted.length ? `<div class="notif-list">${sorted.map((n) => `
          <button class="notif ${!n.quiet && (n.ts || 0) > lastSeen ? 'unread' : ''}" data-link="${esc(n.link || '')}">
            <span class="notif-icon" aria-hidden="true">${KINDS[n.kind] || '🔔'}</span>
            <span class="notif-body"><span class="notif-title">${esc(n.title)}</span>${n.body ? `<span class="small muted">${esc(n.body)}</span>` : ''}<span class="notif-time">${esc(relTime(n.ts || Date.now()))}</span></span>
          </button>`).join('')}</div>`
        : '<p class="muted">Nothing yet. Budget limits, large purchases, bills coming due, subscription price changes and your weekly summary will show up here.</p>'}
        <div class="form-actions">
          ${sorted.length ? '<button type="button" class="btn" data-m="clear">Clear all</button>' : ''}
          <span class="spacer"></span>
          <button type="button" class="btn primary" data-m="close">Done</button>
        </div>
      </div>`);
    setPref('bellSeen', String(Date.now()));
    paint();
    dlg.querySelector('[data-m=close]').onclick = closeModal;
    dlg.querySelector('[data-m=clear]')?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Clear all notifications?', body: 'This only clears the list. Nothing else changes.', confirmLabel: 'Clear all' }))) return;
      list.forEach((n) => store.remove('notifications', n.id));
      toast('Notifications cleared');
    });
    dlg.querySelectorAll('.notif').forEach((b) => {
      b.onclick = () => { const link = b.dataset.link; closeModal(); if (link) location.hash = link; };
    });
  });
}

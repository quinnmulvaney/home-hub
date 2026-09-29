// Spending-limit alerts. computeAlerts is pure (also mirrored in sync/bank_sync.py for phone push);
// notifyNew shows a toast + system notification when a category crosses a threshold while the app is open.
import * as store from './store.js';
import { money, toast, pref, setPref, monthKey } from './util.js';
import { spendByCategory } from './stats.js';

export const DEFAULT_ALERT_AT = 0.8;
const RANK = { near: 1, over: 2 };

// Categories at or past `alertAt` of their monthly budget, worst first.
// `enabled` is the master switch; a category can also opt out with `alerts: false`.
export function computeAlerts(cats, spentByCat, alertAt = DEFAULT_ALERT_AT, enabled = true) {
  const out = [];
  if (!enabled) return out;
  for (const c of cats) {
    const budget = Number(c.budget) || 0;
    if (c.type !== 'expense' || c.archived || c.alerts === false || budget <= 0) continue;
    const spent = spentByCat[c.id] || 0;
    const pct = spent / budget;
    if (pct >= alertAt) out.push({ id: c.id, name: c.name, icon: c.icon || '📦', spent, budget, pct, level: spent - budget > 0.004 ? 'over' : 'near' });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

export function alertMessage(a) {
  return a.level === 'over'
    ? `${a.name}: ${money(a.spent - a.budget)} over its ${money(a.budget)} budget`
    : `${a.name} is at ${Math.round(a.pct * 100)}% of its budget, ${money(a.budget - a.spent)} left`;
}

const pushOnThisDevice = () => { try { return !!localStorage.getItem('homehub:pushDevice'); } catch { return false; } };
export const notificationsGranted = () => 'Notification' in window && Notification.permission === 'granted';

export async function showSystemNotification(title, body, tag = 'homehub') {
  if (!notificationsGranted() || !('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './#/budget' } });
    return true;
  } catch { return false; }
}

// The first call per page load only records what's already true (so opening the app doesn't
// re-announce old alerts, and the banner covers those). Later calls announce anything that got worse.
let baselined = false;
export function notifyNew(alerts, month) {
  let seen;
  try { seen = JSON.parse(pref('alerted', '{}')); } catch { seen = {}; }
  if (seen.month !== month) seen = { month, sent: {} };
  const fresh = [];
  for (const a of alerts) {
    if ((RANK[a.level] || 0) > (RANK[seen.sent[a.id]] || 0)) { seen.sent[a.id] = a.level; fresh.push(a); }
  }
  setPref('alerted', JSON.stringify(seen));
  if (!baselined) { baselined = true; return []; }
  for (const a of fresh) {
    toast(`${a.level === 'over' ? '🚨' : '⚠️'} ${alertMessage(a)}`);
    // With push turned on, the server already notifies this device; don't double up.
    if (!pushOnThisDevice()) showSystemNotification(a.level === 'over' ? 'Over budget' : 'Nearing a budget limit', alertMessage(a), `budget-${a.id}`);
  }
  return fresh;
}

// Watches this month's spending on every screen so alerts show up wherever you are in the app.
export function startAlertMonitor() {
  let cats = [], settings = {}, txs = [];
  const ready = { cats: false, tx: false };
  const check = () => {
    if (!ready.cats || !ready.tx) return;
    const month = monthKey(new Date());
    const b = settings.budget || {};
    notifyNew(computeAlerts(cats, spendByCategory(txs, month), Number(b.alertAt) || DEFAULT_ALERT_AT, b.alertsOn !== false), month);
  };
  store.subscribe('categories', (l) => { cats = l; ready.cats = true; check(); });
  store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); check(); });
  store.subscribeWhere('transactions', [['date', '>=', `${monthKey(new Date())}-01`]], (l) => { txs = l; ready.tx = true; check(); });
}

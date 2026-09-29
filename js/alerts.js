// Spending-limit alerts. computeAlerts is pure (also mirrored in sync/bank_sync.py for phone push);
// notifyNew shows a toast + system notification when a category crosses a threshold while the app is open.
import * as store from './store.js';
import { money, toast, pref, setPref, monthKey, addMonths, todayISO } from './util.js';
import { spendByCategory, isFixedCost } from './stats.js';

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
    const level = spent - budget > 0.004 ? 'over' : 'near';
    // A fixed bill reaching its budget just means it was paid, so only alert when it goes over.
    if (level === 'near' && isFixedCost(c.name)) continue;
    if (pct >= alertAt) out.push({ id: c.id, name: c.name, icon: c.icon || '📦', spent, budget, pct, level });
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

// ---------- large single purchases ----------
// settings/budget: { bigOn, bigAmount }.  category.bigAlerts: undefined = automatic, true = always, false = never.
// Automatic skips fixed bills (mortgage, rent...) and any category where a purchase over the amount happened in
// at least 2 of the last 3 full months, because big purchases are normal there.

// Map of categoryId -> why it's skipped: 'never' | 'fixed' | 'typical'.
export function bigSkipReasons(cats, txs, amount, today = todayISO()) {
  const nowM = today.slice(0, 7);
  const months = [1, 2, 3].map((i) => addMonths(nowM, -i));
  const bigMonths = {};
  for (const t of txs) {
    if (t.type === 'income' || !(t.amount >= amount) || !t.date) continue;
    const m = t.date.slice(0, 7);
    if (months.includes(m)) (bigMonths[t.categoryId] ||= new Set()).add(m);
  }
  const out = new Map();
  for (const c of cats) {
    if (c.type !== 'expense') continue;
    if (c.bigAlerts === true) continue;
    if (c.bigAlerts === false) out.set(c.id, 'never');
    else if (isFixedCost(c.name)) out.set(c.id, 'fixed');
    else if ((bigMonths[c.id]?.size || 0) >= 2) out.set(c.id, 'typical');
  }
  return out;
}

// Recent purchases (last `days` days) at or over `amount`, except in skipped categories. Newest first.
export function computeBigPurchases(cats, txs, { amount, days = 3, today = todayISO() } = {}) {
  if (!(amount > 0)) return [];
  const skip = bigSkipReasons(cats, txs, amount, today);
  const since = new Date(`${today}T12:00:00`);
  since.setDate(since.getDate() - days);
  const sinceISO = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
  const names = new Map(cats.map((c) => [c.id, c.name]));
  return txs
    .filter((t) => t.type !== 'income' && t.amount >= amount && t.date >= sinceISO && !skip.has(t.categoryId))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
    .slice(0, 5)
    .map((t) => ({ id: t.id, amount: t.amount, note: t.note || names.get(t.categoryId) || 'Purchase', date: t.date, category: names.get(t.categoryId) || '' }));
}

export const bigMessage = (p) => `${money(p.amount)} at ${p.note}${p.category ? ` (${p.category})` : ''}`;

let bigBaselined = false;
export function notifyBig(list) {
  let seen;
  try { seen = JSON.parse(pref('bigSeen', '[]')); } catch { seen = []; }
  const fresh = list.filter((p) => !seen.includes(p.id));
  if (fresh.length) setPref('bigSeen', JSON.stringify([...seen, ...fresh.map((p) => p.id)].slice(-300)));
  if (!bigBaselined) { bigBaselined = true; return []; }
  for (const p of fresh) {
    toast(`💳 Large purchase: ${bigMessage(p)}`);
    if (!pushOnThisDevice()) showSystemNotification('Large purchase', bigMessage(p), `big-${p.id}`);
  }
  return fresh;
}

// ---------- monitor ----------
// Watches recent spending on every screen so alerts appear wherever you are in the app, and shares the
// last ~4 months of transactions with screens that want them (so they don't each download their own copy).

const recentSubs = new Set();
let recentTx = [];
export function subscribeRecent(cb) {
  recentSubs.add(cb);
  cb(recentTx);
  return () => recentSubs.delete(cb);
}

export const bigSettings = (settings) => {
  const b = settings.budget || {};
  return { on: b.bigOn === true && Number(b.bigAmount) > 0, amount: Number(b.bigAmount) || 0 };
};

export function startAlertMonitor() {
  let cats = [], settings = {};
  const ready = { cats: false, tx: false };
  const check = () => {
    if (!ready.cats || !ready.tx) return;
    const month = monthKey(new Date());
    const b = settings.budget || {};
    notifyNew(computeAlerts(cats, spendByCategory(recentTx, month), Number(b.alertAt) || DEFAULT_ALERT_AT, b.alertsOn !== false), month);
    const big = bigSettings(settings);
    if (big.on) notifyBig(computeBigPurchases(cats, recentTx, { amount: big.amount }));
  };
  store.subscribe('categories', (l) => { cats = l; ready.cats = true; check(); });
  store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); check(); });
  store.subscribeWhere('transactions', [['date', '>=', `${addMonths(monthKey(new Date()), -3)}-01`]], (l) => {
    recentTx = l;
    ready.tx = true;
    recentSubs.forEach((cb) => cb(l));
    check();
  });
}

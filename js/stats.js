// Pure calculations shared by Budget, Goals and Wedding. No DOM, no storage.
import { merchantKey } from './merchant.js';
import { todayISO, monthKey, addMonths } from './util.js';

export const round2 = (n) => Math.round(n * 100) / 100;
export const sumBy = (list, f = (x) => x.amount) => round2(list.reduce((s, x) => s + (Number(f(x)) || 0), 0));

const parse = (iso) => new Date(`${iso}T12:00:00`);
export const daysBetweenISO = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
export function addMonthsISO(iso, n) {
  const d = parse(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Whole months from `from` to `to`, rounded up, never negative.
export const monthsUntil = (from, to) => Math.max(0, Math.ceil(daysBetweenISO(from, to) / 30.44));

// ---------- spending history ----------

// Categories whose spending is hard to cut. Used to size an emergency fund.
const ESSENTIAL = /mortgage|rent|utilit|grocer|insur|health|medical|transport|loan|tax|home maint/i;
export const isEssential = (name) => ESSENTIAL.test(name || '');

// Averages over up to `n` complete calendar months before this one, ignoring months before the first transaction.
export function averages(txs, cats, n = 3, today = todayISO()) {
  const catById = new Map(cats.map((c) => [c.id, c]));
  const first = txs.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), '');
  const nowMonth = today.slice(0, 7);
  const months = [];
  for (let i = 1; i <= n; i++) {
    const m = addMonths(nowMonth, -i);
    if (first && `${m}-31` >= first) months.push(m);
  }
  const out = { months: months.length, income: 0, spent: 0, essentials: 0, byCat: {} };
  if (!months.length) return out;
  for (const t of txs) {
    if (!t.date || !months.includes(t.date.slice(0, 7))) continue;
    const a = Number(t.amount) || 0;
    if (t.type === 'income') { out.income += a; continue; }
    out.spent += a;
    out.byCat[t.categoryId] = (out.byCat[t.categoryId] || 0) + a;
    if (isEssential(catById.get(t.categoryId)?.name)) out.essentials += a;
  }
  for (const k of ['income', 'spent', 'essentials']) out[k] = round2(out[k] / months.length);
  for (const k of Object.keys(out.byCat)) out.byCat[k] = round2(out.byCat[k] / months.length);
  return out;
}

// Spending in `month` by category id (expenses only, refunds netted).
export function spendByCategory(txs, month) {
  const out = {};
  for (const t of txs) {
    if (t.type === 'income' || !t.date?.startsWith(month)) continue;
    out[t.categoryId] = round2((out[t.categoryId] || 0) + (Number(t.amount) || 0));
  }
  return out;
}

// What rounding every purchase up to the next dollar would have moved to savings.
export function roundUps(txs, month) {
  let total = 0, count = 0;
  for (const t of txs) {
    const a = Number(t.amount) || 0;
    if (t.type === 'income' || a <= 0 || !t.date?.startsWith(month)) continue;
    const up = Math.ceil(a) - a;
    if (up > 0.004) { total += up; count++; }
  }
  return { total: round2(total), count };
}

// Everyday spending that shouldn't be flagged as a subscription even when a total repeats.
const NOT_SUBSCRIPTIONS = /dining|restaurant|coffee|takeout|fuel|gas|shopping|cash/i;

// Charges that repeat about monthly at a steady price: likely subscriptions and bills you could cancel or shop around.
export function recurring(txs, cats, today = todayISO()) {
  const catById = new Map(cats.map((c) => [c.id, c]));
  const since = addMonthsISO(today, -6);
  const groups = new Map();
  for (const t of txs) {
    if (t.type === 'income' || !(t.amount > 0) || !t.date || t.date < since || !t.note) continue;
    const catName = catById.get(t.categoryId)?.name;
    if (isEssential(catName) || NOT_SUBSCRIPTIONS.test(catName || '')) continue;
    const key = merchantKey(t.note).split(' ').slice(0, 2).join(' ');
    if (key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const found = [];
  for (const [key, list] of groups) {
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    if (months.size < 3 || list.length / months.size > 1.6) continue;
    const amounts = list.map((t) => t.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const steady = amounts.filter((a) => Math.abs(a - median) <= median * 0.15).length / amounts.length;
    if (steady < 0.7 || median < 2) continue;
    const latest = list.reduce((a, b) => (a.date > b.date ? a : b));
    found.push({ key, name: latest.note, monthly: round2(median), months: months.size, last: latest.date, categoryId: latest.categoryId });
  }
  return found.sort((a, b) => b.monthly - a.monthly);
}

// ---------- loans ----------

// Months to pay off `balance` at `apr` % with a fixed monthly `payment`; Infinity if it never gets there.
export function amortize(balance, apr, payment) {
  const r = (apr || 0) / 1200;
  let months = 0, interest = 0, b = balance;
  if (b <= 0) return { months: 0, interest: 0 };
  if (payment <= b * r + 0.005) return { months: Infinity, interest: Infinity };
  while (b > 0.005 && months < 1200) {
    const i = b * r;
    interest += i;
    b = b + i - payment;
    months++;
  }
  return { months, interest: round2(interest) };
}

// Monthly payment needed to clear `balance` in `months`.
export function paymentFor(balance, apr, months) {
  const r = (apr || 0) / 1200;
  if (months <= 0) return balance;
  return r ? (balance * r) / (1 - (1 + r) ** -months) : balance / months;
}

// ---------- goals ----------

// Works for any "fund toward a target" object: { id, type, target, startAmount, deadline, monthly, apr }.
// `contribs` are the money moved toward it (negative = money taken out or spent).
export function goalStatus(goal, contribs, today = todayISO()) {
  const mine = contribs.filter((c) => c.goalId === goal.id);
  const added = sumBy(mine);
  const target = Number(goal.target) || 0;
  const saved = round2((Number(goal.startAmount) || 0) + added);
  const remaining = Math.max(round2(target - saved), 0);
  const done = target > 0 && remaining === 0;
  const debt = goal.type === 'debt';
  const apr = Number(goal.apr) || 0;

  // Pace: average of what was added over the last 90 days.
  const cutoff = addMonthsISO(today, -3);
  const pace = round2(Math.max(sumBy(mine.filter((c) => c.date >= cutoff && c.amount > 0)), 0) / 3);

  let neededPerMonth = null, monthsLeft = null;
  if (done) neededPerMonth = 0;
  else if (goal.deadline) {
    monthsLeft = Math.max(1, monthsUntil(today, goal.deadline));
    neededPerMonth = round2(debt && apr ? paymentFor(remaining, apr, monthsLeft) : remaining / monthsLeft);
  } else if (Number(goal.monthly) > 0) neededPerMonth = Number(goal.monthly);

  const payment = pace > 0 ? pace : Number(goal.monthly) || 0;
  let projected = null;
  if (!done && payment > 0 && remaining > 0) {
    const months = debt && apr ? amortize(remaining, apr, payment).months : Math.ceil(remaining / payment);
    if (Number.isFinite(months)) projected = addMonthsISO(today, months);
  }
  const onTrack = done ? true : goal.deadline ? !!projected && projected <= goal.deadline : null;

  return {
    saved, target, remaining, done, pct: target > 0 ? Math.min(saved / target, 1) : 0,
    neededPerMonth, monthsLeft, pace, projected, onTrack, payment,
  };
}

// Wedding: total cost is the larger of each item's estimate and what's been paid. Savings for it are
// contributions with goalId 'wedding' (payments taken from the fund are negative ones), so the fund
// balance is what's set aside and not yet spent, and what's left to save is (still to pay) − (fund balance).
export const WEDDING_ID = 'wedding';
export function weddingSummary(plan, items, contribs, today = todayISO()) {
  const total = sumBy(items, (i) => Math.max(Number(i.estimate) || 0, Number(i.paid) || 0));
  const paid = sumBy(items, (i) => Number(i.paid) || 0);
  const toPay = round2(total - paid);
  const st = goalStatus({ id: WEDDING_ID, type: 'savings', target: toPay, startAmount: 0, deadline: plan?.date || '' }, contribs, today);
  const allPaid = total > 0 && toPay <= 0;
  return { ...st, done: st.done || allPaid, neededPerMonth: allPaid ? 0 : st.neededPerMonth, total, paid, toPay, balance: st.saved };
}

// Consecutive months (ending last month or this one) with at least one contribution to the goal.
export function contributionStreak(contribs, goalId, today = todayISO()) {
  const months = new Set(contribs.filter((c) => c.goalId === goalId && c.amount > 0).map((c) => c.date.slice(0, 7)));
  let m = today.slice(0, 7);
  if (!months.has(m)) m = addMonths(m, -1);
  let n = 0;
  while (months.has(m)) { n++; m = addMonths(m, -1); }
  return n;
}

// Months in a row (through last month) where every budgeted category stayed under its limit.
export function underBudgetStreak(txs, cats, today = todayISO()) {
  const budgeted = cats.filter((c) => c.type === 'expense' && Number(c.budget) > 0);
  if (!budgeted.length) return 0;
  const first = txs.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), '');
  let n = 0, m = addMonths(today.slice(0, 7), -1);
  while (first && `${m}-31` >= first && n < 24) {
    const spent = spendByCategory(txs, m);
    if (budgeted.some((c) => (spent[c.id] || 0) > c.budget)) break;
    n++;
    m = addMonths(m, -1);
  }
  return n;
}

export { monthKey };

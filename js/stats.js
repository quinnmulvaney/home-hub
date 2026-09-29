// Pure calculations shared by Budget, Goals and Wedding. No DOM, no storage.
import { merchantKey } from './merchant.js';
import { todayISO, monthKey, addMonths, money } from './util.js';

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


// ---------- one category, in depth ----------

// `list` is this category's transactions. Looks at the last `months` complete calendar months
// (skipping any before the first data), plus this month so far.
export function categoryInsight(list, months = 3, today = todayISO(), firstDate = '') {
  const nowM = today.slice(0, 7);
  let ms = Array.from({ length: months }, (_, i) => addMonths(nowM, i - months));
  if (firstDate) ms = ms.filter((m) => `${m}-31` >= firstDate);
  const spend = list.filter((t) => t.type !== 'income' && t.date);
  const byMonth = ms.map((m) => {
    const mine = spend.filter((t) => t.date.startsWith(m));
    return { m, total: sumBy(mine), count: mine.filter((t) => t.amount > 0).length };
  });
  const totals = byMonth.map((b) => b.total);
  const n = totals.length;
  const avg = n ? round2(totals.reduce((a, b) => a + b, 0) / n) : 0;
  const high = n ? byMonth.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const low = n ? byMonth.reduce((a, b) => (b.total < a.total ? b : a)) : null;
  const inRange = spend.filter((t) => t.amount > 0 && ms.includes(t.date.slice(0, 7)));
  const sorted = inRange.map((t) => t.amount).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const largest = inRange.reduce((a, b) => (!a || b.amount > a.amount ? b : a), null);

  const groups = new Map();
  for (const t of inRange) {
    const key = merchantKey(t.note).split(' ').slice(0, 2).join(' ') || 'other';
    const g = groups.get(key) || { name: t.note || 'Other', total: 0, count: 0 };
    g.total += t.amount;
    g.count++;
    groups.set(key, g);
  }
  const spendTotal = sumBy(inRange);
  const merchants = [...groups.values()].map((g) => ({ ...g, total: round2(g.total) })).sort((a, b) => b.total - a.total).slice(0, 5)
    .map((g) => ({ ...g, share: spendTotal > 0 ? g.total / spendTotal : 0 }));

  let trend = null;
  if (n >= 2) {
    const before = totals.slice(0, -1).reduce((a, b) => a + b, 0) / (n - 1);
    if (before > 0) trend = (totals[n - 1] - before) / before;
  }
  const mean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
  const cv = n >= 2 && mean > 0 ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / n) / mean : 0;

  return {
    months: n, byMonth, avg, high, low, median: round2(median), avgTx: inRange.length ? round2(spendTotal / inRange.length) : 0,
    largest, count: inRange.length, perMonth: n ? Math.round((inRange.length / n) * 10) / 10 : 0, merchants, trend, cv,
    thisMonth: sumBy(spend.filter((t) => t.date.startsWith(nowM))),
  };
}

const FIXED_RE = /mortgage|\brent\b|loan|insurance|\btax|childcare|daycare|tuition|\bhoa\b|lease|student/i;
// Bills that are paid once at a set amount (mortgage, rent, loans, insurance...). Reaching the budget just means the bill was paid.
export const isFixedCost = (name) => FIXED_RE.test(name || '') && !/fee/i.test(name || '');
const FLEX_RE = /dining|restaurant|coffee|takeout|entertain|subscript|shopping|personal|beauty|travel|vacation|hobb|gift|cloth|cash|fun\b|\bbar\b|other|misc/i;
const ESSENTIAL_RE = /grocer|utilit|transport|\bgas\b|fuel|health|medical|pharm|home maint|phone|internet|electric|water|auto/i;

// Tips by kind of spending: [pattern, tips].
const TIPS = [
  [/mortgage|\brent\b|lease/i, ['The payment itself rarely moves. Check whether refinancing or renegotiating could lower it.', 'Ask your lender or landlord about the escrow and renewal terms once a year.']],
  [/insurance/i, ['Get fresh quotes every year. Loyalty rarely pays.', 'Bundling policies or raising a deductible you can afford often cuts the premium.']],
  [/loan|student/i, ['If the rate is high, refinancing or paying a little extra saves interest.', 'Extra principal payments shorten the loan and free this budget line sooner.']],
  [/tax/i, ['Check withholding and deductions once a year so you are not overpaying.']],
  [/grocer/i, ['Plan the week’s meals and shop from a list.', 'Store brands and buying staples in bulk usually save 10–20%.', 'Use up what you have before restocking. Food waste is money in the trash.']],
  [/utilit|electric|water|phone|internet/i, ['Compare providers or ask for a loyalty rate on internet, phone and power.', 'Budget billing evens out the monthly amount.', 'A smart thermostat and LED bulbs pay for themselves quickly.']],
  [/transport|\bgas\b|fuel|auto/i, ['Combine errands into fewer trips and keep tires properly inflated.', 'Compare gas prices and use a rewards card for fuel.']],
  [/health|medical|pharm/i, ['Generic prescriptions and in-network providers cost far less.', 'Use HSA/FSA money if you have it.']],
  [/dining|restaurant|coffee|takeout/i, ['Swap a couple of meals out each month for home cooking.', 'Set a weekly cap and check it on the Overview.', 'Delivery fees and tips add up. Pick up instead.']],
  [/subscript/i, ['Cancel anything you have not used this month.', 'Share family plans and switch to annual billing where it is cheaper.']],
  [/entertain|fun\b|hobb/i, ['Look for free alternatives for some outings: parks, library, streaming you already pay for.', 'Set a monthly “fun money” amount and enjoy it guilt-free.']],
  [/shopping|cloth|beauty|personal/i, ['Try a 48-hour rule before non-essential purchases.', 'Unsubscribe from promo emails and remove saved cards from shopping apps.']],
  [/travel|vacation/i, ['Book flights and hotels early and travel off-peak.', 'Save for trips in a Goal so the cost never lands on your monthly budget.']],
  [/cash/i, ['Cash disappears without a trace. Note what it is spent on or switch to card for tracking.', 'Use in-network ATMs to avoid fees.']],
  [/fee/i, ['Fees are avoidable. Find which ones repeat (ATM, overdraft, late) and switch accounts or set reminders.']],
];

// Can this be cut, and by how much? Combines what kind of spending it is with how it has actually behaved.
export function reducibility(cat, insight) {
  const name = cat?.name || '';
  let level;
  if (/fee/i.test(name)) level = 'avoidable';
  else if (FIXED_RE.test(name)) level = 'fixed';
  else if (FLEX_RE.test(name)) level = 'flexible';
  else if (ESSENTIAL_RE.test(name)) level = 'essential';
  else level = insight.cv > 0.35 ? 'flexible' : 'essential';

  const base = { fixed: 0, essential: 0.08, flexible: 0.2, avoidable: 1 }[level];
  let cut = base;
  const reasons = [];
  if (level === 'flexible' || level === 'essential') {
    if (insight.trend != null && insight.trend > 0.2) { cut += 0.05; reasons.push(`Up ${Math.round(insight.trend * 100)}% compared with earlier months. Worth a look at what changed.`); }
    if (insight.cv > 0.4) reasons.push('It swings a lot month to month, so a cap would steady it.');
  }
  const small = insight.avg > 0 && insight.avg < 25 && level !== 'avoidable';
  if (small) cut = 0;
  const top = insight.merchants[0];
  if (top && top.share > 0.4 && insight.merchants.length > 1) reasons.push(`${Math.round(top.share * 100)}% of it goes to ${top.name}. Start there.`);
  if (level === 'flexible' && insight.count >= 4 && insight.avgTx > 0) {
    const skip = insight.perMonth >= 4 ? 2 : 1;
    reasons.push(`About ${insight.perMonth} purchases a month averaging ${money(insight.avgTx)}. Skipping ${skip === 1 ? 'one' : 'two'} a month saves ${money(insight.avgTx * skip)}.`);
  }

  const labels = { fixed: 'Fixed cost', essential: 'Mostly essential', flexible: 'Flexible', avoidable: 'Avoidable' };
  const blurbs = {
    fixed: 'A bill that stays about the same. It’s hard to cut month to month, but you can shop around for a better rate.',
    essential: 'You need it, but how much you spend has some give: planning and comparison shopping trim it without much sacrifice.',
    flexible: 'Everyday choices. This is the easiest place to free up money for goals.',
    avoidable: 'Money you shouldn’t have to pay at all.',
  };
  const tips = (TIPS.find(([re]) => re.test(name)) || [null, level === 'flexible'
    ? ['Set a weekly cap for this category and check it on the Overview.']
    : ['Compare prices and look for anything you’re overpaying on.']])[1];
  const cutAmount = round2(insight.avg * cut);
  return {
    level, label: labels[level], blurb: small ? 'This is a small amount. Cutting it wouldn’t change much, so your effort is better spent elsewhere.' : blurbs[level],
    cutPct: cut, cutAmount, target: Math.max(Math.round(insight.avg - cutAmount), 0), reasons, tips, small,
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

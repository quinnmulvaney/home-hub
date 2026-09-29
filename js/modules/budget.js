import * as store from '../store.js';
import {
  esc, money, parseAmount, todayISO, monthKey, addMonths, monthLabel, dayLabel,
  openModal, closeModal, toast, renderKeepingFocus, pref, setPref, newId,
} from '../util.js';
import { merchantKey, suggestRule, ruleMatches } from '../merchant.js';
import { averages, spendByCategory, goalStatus, weddingSummary, round2, categoryInsight, reducibility } from '../stats.js';
import { sortable } from '../sortable.js';
import { computeAlerts, alertMessage, computeBigPurchases, bigSkipReasons, bigMessage, bigSettings, DEFAULT_ALERT_AT } from '../alerts.js';

// Data model (both collections live under the household):
//   categories:   { name, icon, type: 'expense'|'income', budget (monthly), order, archived }
//   transactions: { date 'YYYY-MM-DD', amount (expense < 0 = refund), type, categoryId, note, account?, source?, createdAt, createdBy }
store.registerCollections(['categories', 'transactions', 'rules', 'accounts', 'settings', 'goals', 'contributions', 'weddingItems']);

const DEFAULT_CATEGORIES = [
  ['Paycheck', '💵', 'income'], ['Other income', '🎁', 'income'],
  ['Mortgage / Rent', '🏠', 'expense'], ['Utilities', '💡', 'expense'], ['Groceries', '🛒', 'expense'],
  ['Dining out', '🍔', 'expense'], ['Transportation', '🚗', 'expense'], ['Insurance', '🛡️', 'expense'],
  ['Home maintenance', '🔧', 'expense'], ['Health', '💊', 'expense'], ['Subscriptions', '📺', 'expense'],
  ['Entertainment', '🎬', 'expense'], ['Other', '📦', 'expense'],
];
store.registerSeed((put) => DEFAULT_CATEGORIES.forEach(([name, icon, type], i) =>
  put('categories', newId(), { name, icon, type, budget: 0, order: i, archived: false })));

const EMOJI = ['🏠', '💡', '💧', '🔥', '📶', '🛒', '🍔', '☕', '🚗', '⛽', '🚌', '🛡️', '🔧', '🧹', '🌱', '💊',
  '🐶', '👶', '🎓', '📺', '🎬', '🎮', '✈️', '🎁', '👕', '💇', '🏋️', '💳', '🏦', '💵', '📈', '📦'];

// View state survives switching tabs/modules.
// period: 'month' (default) | 'year' | 'ytd' | 'last3' | 'last12' | 'all' | 'custom'
const ui = {
  month: monthKey(new Date()), period: 'month', year: String(new Date().getFullYear()), from: '', to: '',
  tab: pref('budgetTab', 'overview'), search: '', cat: '',
};
const PERIODS = [['month', 'Month'], ['year', 'Year'], ['ytd', 'Year to date'], ['last3', 'Last 3 months'],
  ['last12', 'Last 12 months'], ['all', 'All time'], ['custom', 'Custom range']];

const lastDayOf = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };
const monthsBetween = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00`) - new Date(`${from}T12:00`)) / 864e5) + 1;
const shortDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const REVIEW = '__review';
const sum = (list) => Math.round(list.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;
const sortCats = (list) => [...list].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name));

export default {
  id: 'budget',
  title: 'Budget',
  icon: '💰',
  render(el) {
    const root = document.createElement('div');
    root.className = 'budget';
    el.appendChild(root);

    let cats = [];
    let txs = [];
    let catById = new Map();
    let accounts = [];
    let bankStatus = null;
    let rules = [];
    let reviewTx = [];      // every bank transaction still needing a category, any month
    let recentList = [];    // last 4 months, only used when the view window doesn't already cover them
    let settings = {};
    let goals = [];
    let contribs = [];
    let wItems = [];
    const ready = { cats: false, tx: false };
    let holdDraw = false;
    let dragging = false;
    let dirty = false;

    // Only the months on screen are loaded from the database, not your whole history.
    let txUnsub = null, recentUnsub = null, viewKey = '', recentKey = '';
    const nowMonth = () => monthKey(new Date());
    const recentFrom = () => `${addMonths(nowMonth(), -3)}-01`;

    function viewWindow() {
      if (ui.period === 'all') return { from: '0000-00-00', to: '9999-12-31' };
      const r = currentRange();
      const span = monthsBetween(r.from, r.to);
      const count = span <= 6 ? 6 : Math.min(span, 24);
      const chartFrom = `${addMonths(r.to.slice(0, 7), -(count - 1))}-01`;
      return { from: chartFrom < r.from ? chartFrom : r.from, to: r.to };
    }

    function syncSubs() {
      const w = viewWindow();
      const key = `${w.from}|${w.to}`;
      if (key !== viewKey) {
        viewKey = key;
        txUnsub?.();
        txs = txs.filter((t) => t.date >= w.from && t.date <= w.to);
        txUnsub = store.subscribeWhere('transactions', [['date', '>=', w.from], ['date', '<=', w.to]], (list) => {
          txs = list;
          ready.tx = true;
          onData();
        });
      }
      const covered = w.from <= recentFrom() && w.to >= todayISO();
      const rk = covered ? 'covered' : recentFrom();
      if (rk !== recentKey) {
        recentKey = rk;
        recentUnsub?.();
        recentUnsub = null;
        if (!covered) recentUnsub = store.subscribeWhere('transactions', [['date', '>=', recentFrom()]], (list) => { recentList = list; onData(); });
      }
    }
    const recent = () => (recentKey === 'covered' ? txs.filter((t) => t.date >= recentFrom()) : recentList);
    const findTx = (id) => txs.find((t) => t.id === id) || reviewTx.find((t) => t.id === id) || recent().find((t) => t.id === id);

    const alertAt = () => Number(settings.budget?.alertAt) || DEFAULT_ALERT_AT;
    const alertsEnabled = () => settings.budget?.alertsOn !== false;
    const currentBig = () => { const b = bigSettings(settings); return b.on ? computeBigPurchases(cats, recent(), { amount: b.amount }) : []; };
    const currentAlerts = () => computeAlerts(cats, spendByCategory(recent(), nowMonth()), alertAt(), alertsEnabled());
    function onData() {
      draw();
    }
    function refresh() { syncSubs(); draw(); }

    // Set aside each month for goals + the wedding fund (feeds the Plan tab).
    function goalNeeds() {
      const g = goals.filter((x) => !x.archived).reduce((sum_, goal) => sum_ + (goalStatus(goal, contribs).neededPerMonth || 0), 0);
      const w = settings.wedding?.date ? weddingSummary(settings.wedding, wItems, contribs).neededPerMonth || 0 : 0;
      return round2(g + w);
    }
    function saveSetting(id, patch) { store.put('settings', id, { ...(settings[id] || {}), ...patch }); }

    const unsubs = [
      store.subscribe('categories', (list) => { cats = sortCats(list); catById = new Map(cats.map((c) => [c.id, c])); ready.cats = true; onData(); }),
      store.subscribe('accounts', (list) => { accounts = list; draw(); }),
      store.subscribe('bankSync', (list) => { bankStatus = list.find((d) => d.id === 'status') || null; draw(); }),
      store.subscribe('rules', (list) => { rules = list; }),
      store.subscribe('settings', (list) => { settings = Object.fromEntries(list.map((d) => [d.id, d])); onData(); }),
      store.subscribe('goals', (list) => { goals = list; draw(); }),
      store.subscribe('contributions', (list) => { contribs = list; draw(); }),
      store.subscribe('weddingItems', (list) => { wItems = list; draw(); }),
      store.subscribeWhere('transactions', [['needsReview', '==', true]], (list) => { reviewTx = list; draw(); }),
      () => txUnsub?.(),
      () => recentUnsub?.(),
    ];

    // The date range every view uses. `months` scales monthly budgets to the range.
    function currentRange() {
      const today = todayISO();
      const nowMonth = monthKey(new Date());
      switch (ui.period) {
        case 'year':
          return { from: `${ui.year}-01-01`, to: `${ui.year}-12-31`, label: ui.year, step: true, months: 12 };
        case 'ytd':
          return { from: `${today.slice(0, 4)}-01-01`, to: today, label: 'Year to date', months: Number(today.slice(5, 7)) };
        case 'last3':
          return { from: `${addMonths(nowMonth, -2)}-01`, to: today, label: 'Last 3 months', months: 3 };
        case 'last12':
          return { from: `${addMonths(nowMonth, -11)}-01`, to: today, label: 'Last 12 months', months: 12 };
        case 'all': {
          const dates = txs.map((t) => t.date).filter(Boolean).sort();
          const from = dates[0] || today;
          const to = dates.length && dates[dates.length - 1] > today ? dates[dates.length - 1] : today;
          return { from, to, label: 'All time', months: monthsBetween(from, to) };
        }
        case 'custom': {
          let from = ui.from || `${nowMonth}-01`;
          let to = ui.to || today;
          if (to < from) [from, to] = [to, from];
          return { from, to, label: `${shortDate(from)} – ${shortDate(to)}`, months: Math.round(daysBetween(from, to) / 30.44 * 10) / 10 };
        }
        default:
          return { from: `${ui.month}-01`, to: lastDayOf(ui.month), label: monthLabel(ui.month), step: true, months: 1 };
      }
    }

    function draw() {
      if (holdDraw || dragging) { dirty = true; return; }
      const range = currentRange();
      const rangeTx = txs.filter((t) => t.date && t.date >= range.from && t.date <= range.to);
      const body = ui.tab === 'transactions' ? transactionsTab(rangeTx, range)
        : ui.tab === 'categories' ? categoriesTab()
        : ui.tab === 'plan' ? planTab()
        : overviewTab(rangeTx, range);
      const showPeriod = ui.tab === 'overview' || ui.tab === 'transactions';
      const isHome = ui.period === 'month' && ui.month === monthKey(new Date());
      renderKeepingFocus(root, `
        <div class="toolbar">
          <div class="period-row" ${showPeriod ? '' : 'hidden'}>
            <select class="input period-select" data-input="period" aria-label="Time period">
              ${PERIODS.map(([id, label]) => `<option value="${id}" ${ui.period === id ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            <div class="month-bar">
              ${range.step ? '<button class="icon-btn" data-action="prev-period" aria-label="Previous">‹</button>' : ''}
              ${range.step || ui.period === 'custom' ? `<button class="month-label" data-action="reset-period" title="${isHome ? '' : 'Back to this month'}">${esc(range.label)}</button>` : ''}
              ${range.step ? '<button class="icon-btn" data-action="next-period" aria-label="Next">›</button>' : ''}
            </div>
          </div>
          <div class="tabs" role="tablist">
            ${[['overview', 'Overview'], ['transactions', 'Transactions'], ['plan', 'Plan'], ['categories', 'Categories']].map(([id, label]) =>
              `<button role="tab" class="tab ${ui.tab === id ? 'active' : ''}" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
          </div>
        </div>
        ${ui.period === 'custom' && showPeriod ? `
          <div class="custom-range">
            <label><span>From</span><input class="input" type="date" data-input="from" value="${esc(range.from)}"></label>
            <label><span>To</span><input class="input" type="date" data-input="to" value="${esc(range.to)}"></label>
          </div>` : ''}
        ${body}
        <button class="fab" data-action="add-tx" aria-label="Add transaction" title="Add transaction">+</button>`);
    }

    // ---------- Overview ----------

    function overviewTab(rangeTx, range) {
      const income = sum(rangeTx.filter((t) => t.type === 'income'));
      const expenses = rangeTx.filter((t) => t.type !== 'income');
      const spent = sum(expenses);
      const budgetCats = cats.filter((c) => c.type === 'expense' && !c.archived);
      const scale = range.months; // monthly budgets × number of months in the range
      const totalBudget = budgetCats.reduce((s, c) => s + (Number(c.budget) || 0), 0) * scale;
      const left = totalBudget - spent;

      const rows = cats.filter((c) => c.type === 'expense').map((c) => {
        const catSpent = sum(expenses.filter((t) => t.categoryId === c.id));
        return { c, spent: catSpent, budget: (Number(c.budget) || 0) * scale };
      }).filter((r) => r.budget > 0 || r.spent > 0);
      const uncategorized = sum(expenses.filter((t) => !catById.has(t.categoryId)));
      if (uncategorized > 0) rows.push({ c: { id: '', name: 'Uncategorized', icon: '❔' }, spent: uncategorized, budget: 0 });

      // "Pace" marker: how far through the month/year we are, when viewing the current one.
      const today = todayISO();
      const isCurrent = (ui.period === 'month' || ui.period === 'year') && today >= range.from && today <= range.to;
      const pace = isCurrent ? daysBetween(range.from, today) / daysBetween(range.from, range.to) : null;
      const inPeriod = ui.period === 'month' ? 'this month' : 'in this period';

      const reviewCount = reviewTx.length;
      const alertList = currentAlerts();
      const bigList = currentBig();
      return `
        ${alertList.length ? `
          <div class="alerts" aria-label="Spending limit alerts">
            ${alertList.map((a) => `
              <button class="alert-row ${a.level}" data-action="alert-cat" data-id="${esc(a.id)}">
                <span>${a.level === 'over' ? '🚨' : '⚠️'} ${esc(alertMessage(a))}</span>
                <span class="review-go">View ›</span>
              </button>`).join('')}
          </div>` : ''}
        ${bigList.length ? `
          <div class="alerts" aria-label="Large purchases">
            ${bigList.map((p) => `
              <button class="alert-row big" data-action="edit-tx" data-id="${esc(p.id)}">
                <span>💳 Large purchase: ${esc(bigMessage(p))}</span>
                <span class="review-go">View ›</span>
              </button>`).join('')}
          </div>` : ''}
        ${reviewCount ? `
          <button class="review-banner" data-action="show-review">
            <span>⚠ <b>${reviewCount}</b> bank transaction${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} a category</span>
            <span class="review-go">Review ›</span>
          </button>` : ''}
        <div class="tiles">
          ${tile('Income', money(income))}
          ${tile('Spent', money(spent))}
          ${totalBudget > 0
            ? tile(left >= 0 ? 'Left to spend' : 'Over budget', money(Math.abs(left)), `of ${money(totalBudget)} budgeted${scale !== 1 ? ` (${scale} mo)` : ''}`, left < 0 ? 'bad' : '')
            : tile('Left to spend', '—', 'Set budgets in Plan')}
          ${tile('Net', money(income - spent, { sign: true }), income - spent >= 0 ? `Saved ${inPeriod}` : 'More out than in')}
        </div>

        <section class="card">
          <div class="card-head">
            <h2>Spending by category</h2>
            ${isCurrent ? `<span class="muted small" title="The line on each bar shows how far through the ${ui.period === 'year' ? 'year' : 'month'} we are">│ = today</span>` : ''}
          </div>
          ${rows.length ? `<div class="budget-list">${rows.map((r) => budgetRow(r, pace)).join('')}</div>`
            : `<p class="muted">No spending ${inPeriod}. Tap <b>+</b> to add a transaction${totalBudget ? '' : ', and set monthly budgets under <b>Plan</b>'}.</p>`}
        </section>

        ${accountsCard()}

        <section class="card">
          ${trendChart(range)}
        </section>`;
    }

    function accountsCard() {
      if (!accounts.length && !bankStatus) return '';
      const ago = (ms) => {
        if (!ms) return 'never';
        const mins = Math.round((Date.now() - ms) / 60000);
        if (mins < 60) return `${Math.max(mins, 1)} min ago`;
        if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
        return `${Math.round(mins / 1440)} days ago`;
      };
      const stale = bankStatus && Date.now() - bankStatus.lastRun > 2 * 864e5;
      const errors = bankStatus?.errors || [];
      return `
        <section class="card">
          <div class="card-head"><h2>Accounts</h2><span class="muted small">Synced ${ago(bankStatus?.lastRun)}</span></div>
          ${errors.length || stale ? `<p class="form-error small">⚠ ${errors.length ? errors.map(esc).join('<br>') : 'Bank sync hasn’t run in over 2 days.'}${errors.length ? '<br>You may need to reconnect this bank in SimpleFIN.' : ''}</p>` : ''}
          <div class="list">
            ${[...accounts].sort((a, b) => a.name.localeCompare(b.name)).map((a) => `
              <div class="row static">
                <span class="cat-icon" aria-hidden="true">${a.balance < 0 ? '💳' : '🏦'}</span>
                <span class="row-main">
                  <span class="row-title">${esc(a.name)}</span>
                  <span class="row-sub">${esc(a.org || '')}${a.balanceDate ? ` · as of ${esc(new Date(a.balanceDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}` : ''}</span>
                </span>
                <span class="row-amt">${a.balance < 0 ? `${money(-a.balance)} <span class="muted small">owed</span>` : money(a.balance)}</span>
              </div>`).join('')}
          </div>
        </section>`;
    }

    function tile(label, value, sub = '', tone = '') {
      return `<div class="tile ${tone}"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
    }

    function budgetRow({ c, spent, budget }, pace) {
      const pct = budget > 0 ? Math.max(0, Math.min(spent / budget, 1)) : 1;
      const over = budget > 0 && spent > budget;
      const sub = budget <= 0 ? 'No budget set'
        : over ? `⚠ ${money(spent - budget)} over`
        : `${money(budget - spent)} left`;
      return `
        <button class="budget-row" data-action="filter-cat" data-id="${esc(c.id)}">
          <span class="cat-icon" aria-hidden="true">${esc(c.icon || '📦')}</span>
          <span class="budget-main">
            <span class="budget-top">
              <span class="name">${esc(c.name)}${c.archived ? ' <span class="muted">(archived)</span>' : ''}</span>
              <span class="amt">${money(spent)}${budget > 0 ? ` <span class="muted">of ${money(budget)}</span>` : ''}</span>
            </span>
            <span class="bar ${budget > 0 ? '' : 'nobudget'}">
              <span class="fill ${over ? 'over' : ''}" style="width:${(pct * 100).toFixed(1)}%"></span>
              ${pace !== null && budget > 0 ? `<span class="pace" style="left:${(pace * 100).toFixed(1)}%"></span>` : ''}
            </span>
            <span class="budget-sub ${over ? 'bad' : ''}">${sub}</span>
          </span>
        </button>`;
    }

    function trendChart(range) {
      // Short ranges: the 6 months ending with it. Longer ranges: every month in it (latest 24).
      const endMonth = range.to.slice(0, 7);
      const span = monthsBetween(range.from, range.to);
      const count = span <= 6 ? 6 : Math.min(span, 24);
      const months = Array.from({ length: count }, (_, i) => addMonths(endMonth, i - count + 1));
      const highlight = ui.period === 'month' ? ui.month : '';
      const data = months.map((m) => {
        const mt = txs.filter((t) => t.date?.startsWith(m));
        return { m, income: sum(mt.filter((t) => t.type === 'income')), spent: sum(mt.filter((t) => t.type !== 'income')) };
      });
      const max = niceMax(Math.max(...data.map((d) => Math.max(d.income, d.spent))));
      const W = 360, H = 180, L = 44, R = 6, T = 10, B = 22;
      const plotW = W - L - R, plotH = H - T - B;
      const groupW = plotW / data.length;
      const barW = Math.min(18, (groupW * 0.62 - 2) / 2);
      const y = (v) => T + plotH - (v / max) * plotH;
      const compact = new Intl.NumberFormat(undefined, { style: 'currency', currency: pref('currency', 'USD'), notation: 'compact', maximumFractionDigits: 1 });

      const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const v = max * f, yy = y(v);
        return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid ${f === 0 ? 'base' : ''}"/>
                <text x="${L - 6}" y="${yy + 3}" class="axis" text-anchor="end">${compact.format(v)}</text>`;
      }).join('');

      const bars = data.map((d, i) => {
        const cx = L + groupW * i + groupW / 2;
        return `
          <g class="col" data-i="${i}">
            <rect class="col-bg" x="${L + groupW * i + 1}" y="${T}" width="${groupW - 2}" height="${plotH}" rx="4"/>
            ${barPath(cx - barW - 1, y(d.income), barW, T + plotH - y(d.income), 'income')}
            ${barPath(cx + 1, y(d.spent), barW, T + plotH - y(d.spent), 'spent')}
            ${count <= 12 || i % 2 === (count - 1) % 2 ? `<text x="${cx}" y="${H - 6}" class="axis ${d.m === highlight ? 'current' : ''}" text-anchor="middle">${esc(monthLabel(d.m, d.m.endsWith('-01') && count > 6 ? { month: 'short', year: '2-digit' } : { month: 'short' }))}</text>` : ''}
            <rect class="hit" x="${L + groupW * i}" y="0" width="${groupW}" height="${H}"/>
          </g>`;
      }).join('');

      return `
        <div class="card-head"><h2>${span <= 6 ? 'Last 6 months' : 'Month by month'}</h2></div>
        <div class="legend">
          <span><i class="sw income"></i>Income</span>
          <span><i class="sw spent"></i>Spent</span>
        </div>
        <div class="chart-wrap" data-chart='${esc(JSON.stringify(data))}'>
          <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Income and spending for the last six months">${grid}${bars}</svg>
          <div class="tooltip" hidden></div>
        </div>
        <details class="table-view">
          <summary>Show as table</summary>
          <table>
            <thead><tr><th>Month</th><th>Income</th><th>Spent</th><th>Net</th></tr></thead>
            <tbody>${data.map((d) => `<tr><td>${esc(monthLabel(d.m, { month: 'short', year: 'numeric' }))}</td><td>${money(d.income)}</td><td>${money(d.spent)}</td><td>${money(d.income - d.spent, { sign: true })}</td></tr>`).join('')}</tbody>
          </table>
        </details>`;
    }

    // Bar with rounded top (data end) and square base.
    function barPath(x, yTop, w, h, cls) {
      if (h <= 0.5) return '';
      const r = Math.min(4, w / 2, h);
      return `<path class="bar-${cls}" d="M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yTop + h} Z"/>`;
    }

    // Top of the y-axis: 4 gridline steps, each a round number (1/2/2.5/5 × 10^n).
    function niceMax(v) {
      if (!(v > 0)) return 100;
      const raw = v / 4;
      const p = 10 ** Math.floor(Math.log10(raw));
      const step = [1, 2, 2.5, 5, 10].find((m) => m * p >= raw) * p;
      return step * 4;
    }

    // ---------- Plan ----------

    // Per-category history and "can this be cut?" verdicts for the Plan tab.
    function planInsights() {
      const active = cats.filter((c) => c.type === 'expense' && !c.archived);
      const recentTx = recent();
      const firstDate = recentTx.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), '');
      const byCat = new Map();
      for (const t of recentTx) { if (!byCat.has(t.categoryId)) byCat.set(t.categoryId, []); byCat.get(t.categoryId).push(t); }
      const insights = new Map(active.map((c) => {
        const ins = categoryInsight(byCat.get(c.id) || [], 3, todayISO(), firstDate);
        return [c.id, { ins, red: reducibility(c, ins) }];
      }));
      // Where a lower budget is realistic: only where the current budget is above the suggested target.
      const trims = active.map((c) => ({ c, ...insights.get(c.id) }))
        .filter((x) => x.red.cutPct > 0 && x.ins.avg > 0 && (Number(x.c.budget) || 0) !== x.red.target && (Number(x.c.budget) || Infinity) > x.red.target)
        .map((x) => ({ ...x, save: round2(x.ins.avg - x.red.target) }))
        .filter((x) => x.save >= 5)
        .sort((a, b) => b.save - a.save)
        .slice(0, 6);
      return { active, insights, trims };
    }

    function planTab() {
      const { active, insights, trims } = planInsights();
      const avg = averages(recent(), cats, 3);
      const budgeted = round2(active.reduce((t, c) => t + (Number(c.budget) || 0), 0));
      const goalsPerMonth = goalNeeds();
      const plannedIncome = Number(settings.budget?.income) || 0;
      const base = plannedIncome || avg.income;
      const left = round2(base - budgeted - goalsPerMonth);
      const share = (v) => (base > 0 ? Math.min(Math.max(v / base, 0), 1) * 100 : 0);
      const at = Math.round(alertAt() * 100);
      const bigOn = settings.budget?.bigOn === true;
      const bigAmount = Number(settings.budget?.bigAmount) || 0;
      const bigSkipped = bigOn && bigAmount > 0
        ? [...bigSkipReasons(cats, recent(), bigAmount)].filter(([, why]) => why !== 'never').map(([cid]) => catById.get(cid)?.name).filter(Boolean)
        : [];
      return `
        <section class="card">
          <div class="card-head"><h2>Monthly plan</h2></div>
          <label class="field"><span>Monthly income to plan around</span>
            <div class="money-input"><span>$</span><input class="input" inputmode="decimal" data-plan-income data-focus-key="plan-income" value="${plannedIncome || ''}" placeholder="${avg.income ? Math.round(avg.income) : '0'}"></div>
          </label>
          <p class="muted small">${avg.months ? `Your average over the last ${avg.months} full month${avg.months === 1 ? '' : 's'} is <b>${money(avg.income)}</b> in, <b>${money(avg.spent)}</b> out.` : 'Add a few months of transactions and averages appear here.'}
            ${plannedIncome ? '' : ' Leave blank to use the average.'}
            ${avg.income && plannedIncome !== Math.round(avg.income) ? ` <button class="link" data-action="plan-income-avg">Use ${money(Math.round(avg.income))}</button>` : ''}</p>
          <div class="alloc" role="img" aria-label="Where your monthly income goes">
            <span class="alloc-seg budget" style="width:${share(budgeted)}%"></span>
            <span class="alloc-seg goals" style="width:${share(Math.min(goalsPerMonth, Math.max(base - budgeted, 0)))}%"></span>
          </div>
          <div class="legend alloc-legend">
            <span><i class="sw alloc-budget"></i>Budgets ${money(budgeted)}</span>
            <span><i class="sw alloc-goals"></i>Goals ${money(goalsPerMonth)}</span>
            <span class="${left < 0 ? 'bad' : 'good'}">${base > 0 ? (left >= 0 ? `Unassigned ${money(left)}` : `Over by ${money(-left)}`) : 'Enter an income'}</span>
          </div>
          ${goalsPerMonth ? '' : '<p class="muted small">Goals aren\'t using any of your income yet. Add some under <a href="#/goals">Goals</a>.</p>'}
        </section>

        ${trims.length ? `
        <section class="card">
          <div class="card-head"><h2>Room to trim</h2><span class="muted small">about ${money(round2(trims.reduce((t, x) => t + x.save, 0)))}/mo</span></div>
          <p class="muted small">Based on your last 3 months and what kind of spending each one is. Tap one to see why.</p>
          <div class="trims">${trims.map((x) => `
            <button class="trim-row" data-action="cat-detail" data-id="${esc(x.c.id)}">
              <span class="cat-icon" aria-hidden="true">${esc(x.c.icon || '📦')}</span>
              <span class="plan-main"><span class="name"><span class="name-link">${esc(x.c.name)}</span> <span class="tag ${x.red.level}">${esc(x.red.label)}</span></span>
                <span class="muted small">Averages ${money(x.ins.avg)}, try ${money(x.red.target)}</span></span>
              <span class="good trim-save">−${money(x.save)}</span>
            </button>`).join('')}</div>
          <button class="btn primary" data-action="plan-trim-all">Set these budgets</button>
        </section>` : ''}

        <section class="card">
          <div class="card-head"><h2>Monthly budgets</h2><span class="muted small">${money(budgeted)} total</span></div>
          <p class="muted small">Drag the <span class="grip-inline" aria-hidden="true"></span> handle to reorder. Tap an underlined category name to see its history and decide on an amount.</p>
          <div class="btn-row plan-tools">
            <button class="btn" data-action="plan-fill">Fill from my average</button>
            <button class="btn" data-action="plan-round">Round to $10</button>
            <button class="btn" data-action="plan-clear">Clear all</button>
          </div>
          <div class="plan-list">
            ${active.map((c) => {
              const { ins, red } = insights.get(c.id);
              const b = Number(c.budget) || 0;
              return `
              <div class="plan-row" data-id="${esc(c.id)}">
                <button class="drag-handle" data-focus-key="drag-${esc(c.id)}" aria-label="Reorder ${esc(c.name)}. Drag, or use the up and down arrow keys." title="Drag to reorder"></button>
                <button class="plan-open" data-action="cat-detail" data-id="${esc(c.id)}" aria-label="${esc(c.name)} spending details">
                  <span class="cat-icon" aria-hidden="true">${esc(c.icon || '📦')}</span>
                  <span class="plan-main">
                    <span class="name"><span class="name-link">${esc(c.name)}</span> ${ins.months ? `<span class="tag ${red.level}">${esc(red.label)}</span>` : ''}</span>
                    <span class="muted small">${ins.months && ins.avg > 0 ? `Avg ${money(ins.avg)} · High ${money(ins.high.total)} · Low ${money(ins.low.total)}` : 'No spending in the last 3 months'}</span>
                  </span>
                  <span class="chev" aria-hidden="true">›</span>
                </button>
                <button class="bell ${c.alerts === false ? '' : 'on'}" data-action="toggle-alert" data-id="${esc(c.id)}" aria-pressed="${c.alerts !== false}" aria-label="Limit alerts for ${esc(c.name)}: ${c.alerts === false ? 'off' : 'on'}. Tap to switch." title="${c.alerts === false ? 'Alerts off' : 'Alerts on'}">${c.alerts === false ? '🔕' : '🔔'}</button>
                <span class="money-input"><span>$</span><input class="input" inputmode="decimal" data-plan="${esc(c.id)}" data-focus-key="plan-${esc(c.id)}" value="${b || ''}" placeholder="0" aria-label="${esc(c.name)} monthly budget"></span>
              </div>`;
            }).join('')}
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Alerts</h2></div>
          <label class="check master-alert"><input type="checkbox" data-plan-alerts-on ${alertsEnabled() ? 'checked' : ''}><span><b>Category limit alerts</b><br><span class="muted small">Turn all limit warnings on or off. Use the 🔔 on each category to pick which ones.</span></span></label>
          <label class="field"><span>Warn me when a category reaches</span>
            <select class="input" data-plan-alert ${alertsEnabled() ? '' : 'disabled'}>
              ${[70, 80, 90, 100].map((v) => `<option value="${v}" ${v === at ? 'selected' : ''}>${v}% of its budget</option>`).join('')}
            </select>
          </label>
          <hr class="sep">
          <label class="check master-alert"><input type="checkbox" data-plan-big-on ${bigOn ? 'checked' : ''}><span><b>Large purchase alerts</b><br><span class="muted small">Tell me about any single purchase over the amount below.</span></span></label>
          <label class="field"><span>Alert me for purchases over</span>
            <div class="money-input"><span>$</span><input class="input" inputmode="decimal" data-plan-big-amount data-focus-key="plan-big" value="${bigAmount || ''}" placeholder="200" ${bigOn ? '' : 'disabled'}></div>
          </label>
          ${bigOn && bigSkipped.length ? `<p class="muted small">Skipped automatically because big purchases are normal there: <b>${bigSkipped.map(esc).join(', ')}</b>. Change this per category in its details.</p>` : ''}
          <p class="muted small">You'll see a banner on Overview and a message when it happens. To also get alerts on your phone when the app is closed, turn on notifications in <a href="#/settings">Settings</a>.</p>
        </section>`;
    }

    // Save a plan edit without redrawing under the user's fingers (tabbing to the next box would lose focus).
    function holdRedraw() {
      holdDraw = true;
      setTimeout(() => { holdDraw = false; if (dirty) { dirty = false; draw(); } }, 400);
    }

    // ---------- Transactions ----------

    function transactionsTab(rangeTx, range) {
      const q = ui.search.trim().toLowerCase();
      const reviewing = ui.cat === REVIEW;
      const reviewCount = reviewTx.length;
      const list = (reviewing ? reviewTx : rangeTx)
        .filter((t) => reviewing || !ui.cat || t.categoryId === ui.cat)
        .filter((t) => {
          if (!q) return true;
          const c = catById.get(t.categoryId);
          return `${t.note || ''} ${c?.name || ''} ${t.account || ''} ${t.amount}`.toLowerCase().includes(q);
        })
        .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));

      const byDay = new Map();
      list.forEach((t) => { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); });

      const income = sum(list.filter((t) => t.type === 'income'));
      const spent = sum(list.filter((t) => t.type !== 'income'));

      return `
        <div class="filters">
          <input type="search" class="input" placeholder="Search notes, categories, amounts" value="${esc(ui.search)}" data-focus-key="search" data-input="search" aria-label="Search transactions">
          <select class="input" data-input="cat" aria-label="Filter by category">
            <option value="">All categories</option>
            ${reviewCount || reviewing ? `<option value="${REVIEW}" ${reviewing ? 'selected' : ''}>⚠ Needs review (${reviewCount}, all months)</option>` : ''}
            ${cats.map((c) => `<option value="${esc(c.id)}" ${ui.cat === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        ${reviewing && list.length ? '<p class="small summary-line">Tap each one and pick a category. Tick “always” to teach the sync for next time.</p>' : ''}
        <p class="muted small summary-line">${list.length} transaction${list.length === 1 ? '' : 's'} · Spent ${money(spent)} · Income ${money(income)}</p>
        ${list.length ? [...byDay].map(([day, items]) => `
          <section class="day">
            <h3 class="day-head"><span>${esc(dayLabel(day))}</span></h3>
            <div class="card list">${items.map(txRow).join('')}</div>
          </section>`).join('')
        : `<div class="empty small"><p>No transactions${ui.cat || q ? ' match your filter' : ` in ${ui.period === 'month' ? esc(monthLabel(ui.month, { month: 'long' })) : 'this period'}`}.</p>
            ${ui.cat || q ? '<button class="btn" data-action="clear-filter">Clear filter</button>' : '<p class="muted">Tap <b>+</b> to add one, or import a bank CSV from <a href="#/settings">Settings</a>.</p>'}</div>`}`;
    }

    function txRow(t) {
      const c = catById.get(t.categoryId);
      const isIncome = t.type === 'income';
      const isRefund = !isIncome && t.amount < 0;
      const sub = [t.note ? c?.name || 'Uncategorized' : '', isRefund ? 'Refund' : '', t.account || ''].filter(Boolean).join(' · ');
      const badge = t.needsReview ? '<span class="badge warn">Review</span> ' : '';
      return `
        <button class="row" data-action="edit-tx" data-id="${esc(t.id)}">
          <span class="cat-icon" aria-hidden="true">${esc(c?.icon || '❔')}</span>
          <span class="row-main">
            <span class="row-title">${badge}${esc(t.note || c?.name || 'Uncategorized')}</span>
            ${sub ? `<span class="row-sub">${esc(sub)}</span>` : ''}
          </span>
          <span class="row-amt ${isIncome || isRefund ? 'pos' : ''}">${isIncome || isRefund ? '+' : '−'}${money(Math.abs(t.amount))}</span>
        </button>`;
    }

    // ---------- Categories ----------

    function categoriesTab() {
      const active = cats.filter((c) => !c.archived);
      const expense = active.filter((c) => c.type === 'expense');
      const income = active.filter((c) => c.type === 'income');
      const archived = cats.filter((c) => c.archived);
      const totalBudget = expense.reduce((s, c) => s + (Number(c.budget) || 0), 0);
      const section = (title, list, extra = '') => `
        <section class="card">
          <div class="card-head"><h2>${title}</h2>${extra}</div>
          ${list.length ? `<div class="list">${list.map(catRow).join('')}</div>` : '<p class="muted">None yet.</p>'}
        </section>`;
      return `
        <p class="muted small">Budgets repeat every month. Tap a category to change its name, icon or budget.</p>
        ${section('Spending', expense, `<span class="muted small">${money(totalBudget)} / month</span>`)}
        ${section('Income', income)}
        ${archived.length ? section('Archived', archived) : ''}
        <button class="btn block" data-action="add-cat">+ Add category</button>`;
    }

    function catRow(c) {
      return `
        <button class="row" data-action="edit-cat" data-id="${esc(c.id)}">
          <span class="cat-icon" aria-hidden="true">${esc(c.icon || '📦')}</span>
          <span class="row-main"><span class="row-title">${esc(c.name)}</span></span>
          <span class="row-amt muted">${c.type === 'expense' ? (Number(c.budget) > 0 ? `${money(c.budget)}/mo` : 'No budget') : ''}</span>
        </button>`;
    }

    // ---------- Modals ----------

    function txModal(tx) {
      const editing = !!tx;
      const type = tx?.type || 'expense';
      const range = currentRange();
      const defaultDate = todayISO() >= range.from && todayISO() <= range.to ? todayISO() : range.from;
      // Bank-sourced rows can create a merchant rule the sync applies from then on.
      const suggested = editing && (tx.source === 'bank' || tx.source === 'import') ? suggestRule(tx.note) : '';
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit transaction' : 'Add transaction'}</h2>
          <div class="seg" role="radiogroup" aria-label="Type">
            <label><input type="radio" name="type" value="expense" ${type === 'expense' ? 'checked' : ''}><span>Expense</span></label>
            <label><input type="radio" name="type" value="income" ${type === 'income' ? 'checked' : ''}><span>Income</span></label>
          </div>
          <label class="field"><span>Amount</span>
            <input class="input amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${tx ? esc(tx.amount) : ''}" ${editing ? '' : 'autofocus'}>
          </label>
          <label class="field"><span>Category</span><select class="input" name="categoryId"></select></label>
          <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${esc(tx?.date || defaultDate)}"></label>
          <label class="field"><span>Note <span class="muted">(optional)</span></span>
            <input class="input" name="note" maxlength="120" placeholder="e.g. Costco run" value="${esc(tx?.note || '')}">
          </label>
          ${suggested ? `
          <div class="rule-box">
            <label class="check"><input type="checkbox" name="always" ${tx.needsReview ? 'checked' : ''}>
              <span>Always use this category for bank transactions starting with</span></label>
            <input class="input" name="ruleMatch" value="${esc(suggested)}" aria-label="Merchant name to match">
          </div>` : ''}
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing ? '<button type="button" class="btn danger" data-m="delete">Delete</button>' : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      const select = form.categoryId;
      const fillCats = () => {
        const t = form.type.value;
        const options = cats.filter((c) => c.type === t && (!c.archived || c.id === tx?.categoryId));
        const chosen = (tx && tx.type === t && tx.categoryId) || pref(`lastCat:${t}`, '') || '';
        select.innerHTML = options.map((c) => `<option value="${esc(c.id)}" ${c.id === chosen ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')
          || '<option value="">No categories — add one first</option>';
      };
      fillCats();
      form.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', fillCats));
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = () => {
        if (!confirm('Delete this transaction?')) return;
        store.remove('transactions', tx.id);
        closeModal();
        toast('Transaction deleted');
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const amount = parseAmount(form.amount.value);
        const err = form.querySelector('.form-error');
        if (!amount) { err.textContent = 'Enter an amount (use a minus sign for a refund).'; err.hidden = false; form.amount.focus(); return; }
        if (!form.date.value) { err.textContent = 'Pick a date.'; err.hidden = false; return; }
        const data = {
          amount,
          type: form.type.value,
          categoryId: select.value,
          date: form.date.value,
          note: form.note.value.trim(),
        };
        setPref(`lastCat:${data.type}`, data.categoryId);
        let extra = 0;
        if (editing) {
          store.update('transactions', tx.id, { ...data, needsReview: false });
          const rule = suggested && form.always?.checked ? merchantKey(form.ruleMatch.value) : '';
          if (rule) extra = saveRule(rule, data, tx.id);
        } else {
          store.add('transactions', { ...data, createdAt: Date.now(), createdBy: store.getState().user?.email || '' });
        }
        closeModal();
        toast(extra ? `Saved, plus ${extra} more like it` : editing ? 'Saved' : 'Added');
        if (!editing && ui.period === 'month' && !data.date.startsWith(ui.month)) { ui.month = data.date.slice(0, 7); refresh(); }
      };
    }

    // Delete a category. If transactions use it, offer to move them to another category first.
    async function deleteCategory(c) {
      let used = 0;
      try { used = await store.countWhere('transactions', [['categoryId', '==', c.id]]); } catch { used = 1; }
      if (!used) {
        if (!confirm(`Delete “${c.name}”?`)) return;
        store.remove('categories', c.id);
        closeModal();
        toast(`${c.name} deleted`);
        return;
      }
      const others = cats.filter((x) => x.id !== c.id && x.type === c.type && !x.archived);
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>Delete “${esc(c.name)}”?</h2>
          <p><b>${used}</b> transaction${used === 1 ? '' : 's'} use${used === 1 ? 's' : ''} this category. Choose where ${used === 1 ? 'it goes' : 'they go'} so your history stays accurate:</p>
          <label class="field"><span>Move them to</span>
            <select class="input" name="to">
              ${others.map((x) => `<option value="${esc(x.id)}">${esc(x.icon || '')} ${esc(x.name)}</option>`).join('')}
              <option value="">Leave them uncategorized</option>
            </select></label>
          <p class="form-error" hidden></p>
          <div class="form-actions"><span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn danger">Delete category</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Deleting…';
        try {
          if (form.to.value) {
            const docs = await store.fetchWhere('transactions', [['categoryId', '==', c.id]]);
            await store.bulkUpdate('transactions', docs.map((t) => t.id), { categoryId: form.to.value });
          }
          rules.filter((r) => r.categoryId === c.id).forEach((r) => store.remove('rules', r.id));
          store.remove('categories', c.id);
          closeModal();
          toast(`${c.name} deleted${form.to.value ? `, ${used} moved to ${catById.get(form.to.value)?.name || 'another category'}` : ''}`);
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          btn.textContent = 'Delete category';
          const el = form.querySelector('.form-error');
          el.textContent = `Couldn't finish: ${err.message}`;
          el.hidden = false;
        }
      };
    }

    // Rewrite category order after a drag: the moved categories keep their slots among all categories.
    function reorderPlan(ids) {
      const active = cats.filter((c) => c.type === 'expense' && !c.archived);
      const slots = active.map((c) => cats.indexOf(c));
      const full = [...cats];
      ids.forEach((id, i) => { full[slots[i]] = catById.get(id); });
      full.forEach((c, i) => { if (c && c.order !== i) store.update('categories', c.id, { order: i }); });
    }

    // Everything about one category over the last 3 full months, and what a sensible budget could be.
    function catDetail(id) {
      const c = catById.get(id);
      if (!c) return;
      const recentTx = recent();
      const first = recentTx.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), '');
      const ins = categoryInsight(recentTx.filter((t) => t.categoryId === id), 3, todayISO(), first);
      const red = reducibility(c, ins);
      const budget = Number(c.budget) || 0;
      const mLabel = (m) => monthLabel(m, { month: 'short' });
      const scaleMax = Math.max(ins.high?.total || 0, budget, ins.thisMonth, 1);
      const overCount = budget > 0 ? ins.byMonth.filter((b) => b.total > budget).length : 0;
      const trendTxt = ins.trend == null ? 'Not enough history'
        : Math.abs(ins.trend) < 0.1 ? 'Steady'
        : ins.trend > 0 ? `<span class="bad">↑ ${Math.round(ins.trend * 100)}% vs earlier months</span>` : `<span class="good">↓ ${Math.round(-ins.trend * 100)}% vs earlier months</span>`;
      const goal = goals.filter((g) => !g.archived).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (a.createdDate || '').localeCompare(b.createdDate || ''))
        .map((g) => ({ g, st: goalStatus(g, contribs) })).find((x) => !x.st.done);
      let goalLine = '';
      if (goal && red.cutAmount >= 5) {
        const base = goal.st.payment || goal.st.neededPerMonth || 0;
        if (base > 0) {
          const m0 = Math.ceil(goal.st.remaining / base), m1 = Math.ceil(goal.st.remaining / (base + red.cutAmount));
          if (m0 > m1) goalLine = ` Put that toward <b>${esc(goal.g.name)}</b> and you'd get there <b>${m0 - m1} month${m0 - m1 === 1 ? '' : 's'} sooner</b>.`;
        }
      }
      const bigAmt = Number(settings.budget?.bigAmount) || 200;
      const bigReason = bigSkipReasons(cats, recentTx, bigAmt).get(id);
      const bigWhy = { fixed: 'fixed bill', typical: 'big purchases are normal here' }[bigReason] || '';
      const options = ins.months ? [
        ['Lowest month', ins.low.total], ['Average', ins.avg], ['Highest month', ins.high.total],
        ...(red.cutPct > 0 && !red.small ? [[`Target (−${Math.round(red.cutPct * 100)}%)`, red.target]] : []),
      ].map(([label, v]) => [label, Math.round(v)]) : [];

      const dlg = openModal(`
        <div class="form detail">
          <div class="detail-head"><span class="cat-icon">${esc(c.icon || '📦')}</span>
            <div><h2>${esc(c.name)}</h2><span class="muted small">Last ${ins.months || 3} full months · budget ${budget ? `${money(budget)}/mo` : 'not set'}</span></div></div>
          ${ins.months ? `
          <div class="stat-grid three">
            <div><span class="muted small">Average</span><b>${money(ins.avg)}</b></div>
            <div><span class="muted small">High · ${esc(mLabel(ins.high.m))}</span><b>${money(ins.high.total)}</b></div>
            <div><span class="muted small">Low · ${esc(mLabel(ins.low.m))}</span><b>${money(ins.low.total)}</b></div>
          </div>
          <div class="mbars" role="img" aria-label="Spending by month">
            ${[...ins.byMonth.map((b) => ({ label: mLabel(b.m), v: b.total })), { label: `${mLabel(nowMonth())} so far`, v: ins.thisMonth, partial: true }].map((b) => `
              <div class="mbar ${b.partial ? 'partial' : ''}"><span class="mlabel">${esc(b.label)}</span>
                <span class="mtrack"><span class="mfill ${budget > 0 && b.v > budget ? 'over' : ''}" style="width:${Math.max(b.v, 0) / scaleMax * 100}%"></span>${budget > 0 ? `<span class="mbudget" style="left:${budget / scaleMax * 100}%" title="Budget"></span>` : ''}</span>
                <b>${money(b.v)}</b></div>`).join('')}
            ${budget > 0 ? '<div class="muted small mlegend">│ = your budget</div>' : ''}
          </div>
          <div class="kv">
            <div><span>Typical purchase</span><b>${money(ins.median)}</b></div>
            <div><span>Average purchase</span><b>${money(ins.avgTx)}</b></div>
            <div><span>Purchases per month</span><b>${ins.perMonth}</b></div>
            <div><span>Largest purchase</span><b>${ins.largest ? `${money(ins.largest.amount)} <span class="muted small">${esc(ins.largest.note || '')}</span>` : '—'}</b></div>
            <div><span>Trend</span><b>${trendTxt}</b></div>
            ${budget > 0 ? `<div><span>Months over budget</span><b class="${overCount ? 'bad' : 'good'}">${overCount} of ${ins.months}</b></div>` : ''}
          </div>
          ${ins.merchants.length ? `
          <h3 class="detail-sub">Where it goes</h3>
          <ul class="subs">${ins.merchants.slice(0, 5).map((m) => `<li><span>${esc(m.name)}</span><b>${money(m.total)}</b><span class="muted small">${m.count}× · ${Math.round(m.share * 100)}%</span></li>`).join('')}</ul>` : ''}

          <div class="reduce ${red.level}">
            <div class="reduce-head"><span class="tag ${red.level}">${esc(red.label)}</span><b>Can this be reduced?</b></div>
            <p>${esc(red.blurb)}</p>
            ${red.cutPct > 0 && !red.small ? `<p class="reduce-save">Trimming about <b>${Math.round(red.cutPct * 100)}%</b> would free up <b>${money(red.cutAmount)}/month</b> (${money(red.cutAmount * 12)}/year).${goalLine}</p>` : ''}
            ${red.reasons.length || red.tips.length ? `<ul class="tips">${[...red.reasons, ...red.tips].map((t) => `<li>${t.includes('<') ? t : esc(t)}</li>`).join('')}</ul>` : ''}
          </div>` : '<p class="muted">No spending in this category in the last 3 full months, so there’s nothing to base a budget on yet.</p>'}

          <label class="check detail-alert"><input type="checkbox" data-alert-toggle ${c.alerts === false ? '' : 'checked'}><span>Alert me when this nears its limit</span></label>
          <label class="field detail-big"><span>Large purchase alerts</span>
            <select class="input" data-big-mode>
              <option value="auto" ${c.bigAlerts == null ? 'selected' : ''}>Automatic${bigWhy ? ` (skipped: ${bigWhy})` : ''}</option>
              <option value="on" ${c.bigAlerts === true ? 'selected' : ''}>Always alert</option>
              <option value="off" ${c.bigAlerts === false ? 'selected' : ''}>Never alert</option>
            </select>
          </label>
          <h3 class="detail-sub">Set the monthly budget</h3>
          ${options.length ? `<div class="chips set-chips">${options.map(([label, v]) => `<button class="btn sm ${v === budget ? 'primary' : ''}" data-set="${v}">${esc(label)} ${money(v)}</button>`).join('')}</div>` : ''}
          <div class="inline set-custom">
            <div class="money-input"><span>$</span><input class="input" inputmode="decimal" placeholder="Custom amount" data-custom value="${budget || ''}" aria-label="Custom monthly budget"></div>
            <button class="btn primary" data-save>Save</button>
          </div>
          <div class="form-actions">
            <button type="button" class="btn" data-m="tx">View transactions</button>
            <button type="button" class="btn danger" data-m="delete">Delete</button>
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="close">Close</button>
          </div>
        </div>`);
      const setBudget = (v) => {
        if (!(v >= 0)) { toast('Enter a number'); return; }
        store.update('categories', id, { budget: v });
        closeModal();
        toast(`${c.name} budget set to ${money(v)}`);
      };
      dlg.querySelectorAll('[data-set]').forEach((b) => { b.onclick = () => setBudget(Number(b.dataset.set)); });
      dlg.querySelector('[data-save]').onclick = () => {
        const raw = dlg.querySelector('[data-custom]').value.trim();
        setBudget(raw === '' ? 0 : parseAmount(raw));
      };
      dlg.querySelector('[data-custom]').onkeydown = (e) => { if (e.key === 'Enter') dlg.querySelector('[data-save]').click(); };
      dlg.querySelector('[data-alert-toggle]').onchange = (e) => {
        store.update('categories', id, { alerts: e.target.checked });
        toast(e.target.checked ? `Alerts on for ${c.name}` : `Alerts off for ${c.name}`);
      };
      dlg.querySelector('[data-big-mode]').onchange = (e) => {
        store.update('categories', id, { bigAlerts: e.target.value === 'on' ? true : e.target.value === 'off' ? false : null });
        toast('Saved');
      };
      dlg.querySelector('[data-m=delete]').onclick = () => deleteCategory(c);
      dlg.querySelector('[data-m=close]').onclick = closeModal;
      dlg.querySelector('[data-m=tx]').onclick = () => {
        ui.period = 'custom'; ui.from = `${addMonths(nowMonth(), -3)}-01`; ui.to = todayISO();
        ui.cat = id; ui.search = ''; ui.tab = 'transactions';
        closeModal();
        refresh();
      };
    }

    // Remember merchant -> category, and apply it to other rows from that merchant still awaiting review.
    function saveRule(key, data, exceptId) {
      const existing = rules.find((r) => r.match === key);
      const rule = { match: key, categoryId: data.categoryId, type: data.type };
      if (existing) store.update('rules', existing.id, rule);
      else store.add('rules', rule);
      const others = reviewTx.filter((t) => t.id !== exceptId && ruleMatches(key, t.note));
      others.forEach((t) => store.update('transactions', t.id, {
        categoryId: data.categoryId,
        type: data.type,
        amount: data.type === t.type ? t.amount : -t.amount,
        needsReview: false,
      }));
      return others.length;
    }

    function catModal(cat) {
      const editing = !!cat;
      const inUse = editing && txs.some((t) => t.categoryId === cat.id);
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit category' : 'New category'}</h2>
          <div class="field-row">
            <label class="field icon-field"><span>Icon</span><input class="input emoji-input" name="icon" maxlength="8" value="${esc(cat?.icon || '📦')}"></label>
            <label class="field grow"><span>Name</span><input class="input" name="name" maxlength="40" value="${esc(cat?.name || '')}" ${editing ? '' : 'autofocus'}></label>
          </div>
          <div class="emoji-grid">${EMOJI.map((e) => `<button type="button" class="emoji" data-emoji="${e}">${e}</button>`).join('')}</div>
          <div class="seg" role="radiogroup" aria-label="Type">
            <label><input type="radio" name="type" value="expense" ${(cat?.type || 'expense') === 'expense' ? 'checked' : ''}><span>Spending</span></label>
            <label><input type="radio" name="type" value="income" ${cat?.type === 'income' ? 'checked' : ''}><span>Income</span></label>
          </div>
          <label class="field budget-field"><span>Monthly budget</span>
            <input class="input" name="budget" inputmode="decimal" placeholder="0.00" value="${Number(cat?.budget) > 0 ? esc(cat.budget) : ''}">
          </label>
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing ? (inUse
              ? `<button type="button" class="btn" data-m="archive">${cat.archived ? 'Unarchive' : 'Archive'}</button>`
              : '<button type="button" class="btn danger" data-m="delete">Delete</button>') : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      const syncBudgetField = () => { form.querySelector('.budget-field').hidden = form.type.value !== 'expense'; };
      syncBudgetField();
      form.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', syncBudgetField));
      form.querySelector('.emoji-grid').onclick = (e) => {
        const b = e.target.closest('[data-emoji]');
        if (b) form.icon.value = b.dataset.emoji;
      };
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = () => {
        if (!confirm(`Delete “${cat.name}”?`)) return;
        store.remove('categories', cat.id);
        closeModal();
        toast('Category deleted');
      };
      const arch = form.querySelector('[data-m=archive]');
      if (arch) arch.onclick = () => {
        store.update('categories', cat.id, { archived: !cat.archived });
        closeModal();
        toast(cat.archived ? 'Category restored' : 'Category archived — its history is kept');
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const name = form.name.value.trim();
        const err = form.querySelector('.form-error');
        if (!name) { err.textContent = 'Give it a name.'; err.hidden = false; form.name.focus(); return; }
        const budget = form.type.value === 'expense' ? parseAmount(form.budget.value || '0') : 0;
        if (!(budget >= 0)) { err.textContent = 'Budget must be a number.'; err.hidden = false; return; }
        const data = { name, icon: form.icon.value.trim() || '📦', type: form.type.value, budget };
        if (editing) store.update('categories', cat.id, data);
        else store.add('categories', { ...data, order: cats.length, archived: false });
        closeModal();
        toast('Saved');
      };
    }

    // ---------- Events ----------

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const id = b.dataset.id;
      switch (b.dataset.action) {
        case 'prev-period':
        case 'next-period': {
          const d = b.dataset.action === 'prev-period' ? -1 : 1;
          if (ui.period === 'year') ui.year = String(Number(ui.year) + d);
          else ui.month = addMonths(ui.month, d);
          break;
        }
        case 'reset-period': ui.period = 'month'; ui.month = monthKey(new Date()); break;
        case 'tab': ui.tab = b.dataset.tab; setPref('budgetTab', ui.tab); break;
        case 'filter-cat': ui.cat = id; ui.search = ''; ui.tab = 'transactions'; break;
        case 'clear-filter': ui.cat = ''; ui.search = ''; break;
        case 'show-review': ui.cat = REVIEW; ui.search = ''; ui.tab = 'transactions'; break;
        case 'add-tx': return txModal(null);
        case 'edit-tx': return txModal(findTx(id));
        case 'alert-cat': ui.period = 'month'; ui.month = nowMonth(); ui.cat = id; ui.search = ''; ui.tab = 'transactions'; break;
        case 'cat-detail': return catDetail(id);
        case 'toggle-alert': {
          const c = catById.get(id);
          if (!c) return;
          store.update('categories', id, { alerts: c.alerts === false });
          toast(c.alerts === false ? `Alerts on for ${c.name}` : `Alerts off for ${c.name}`);
          return;
        }
        case 'plan-trim-all': {
          const { trims } = planInsights();
          if (!trims.length) return;
          trims.forEach((x) => store.update('categories', x.c.id, { budget: x.red.target }));
          toast(`Budgets lowered by about ${money(round2(trims.reduce((t, x) => t + x.save, 0)))} a month`);
          return;
        }
        case 'plan-use': holdRedraw(); store.update('categories', id, { budget: Number(b.dataset.val) }); dirty = true; return;
        case 'plan-income-avg': saveSetting('budget', { income: Math.round(averages(recent(), cats, 3).income) }); return;
        case 'plan-fill': {
          const avg = averages(recent(), cats, 3);
          cats.filter((c) => c.type === 'expense' && !c.archived && avg.byCat[c.id] > 0)
            .forEach((c) => store.update('categories', c.id, { budget: Math.round(avg.byCat[c.id]) }));
          toast('Budgets set to your recent averages');
          return;
        }
        case 'plan-round':
          cats.filter((c) => c.type === 'expense' && Number(c.budget) > 0)
            .forEach((c) => store.update('categories', c.id, { budget: Math.round(c.budget / 10) * 10 }));
          return;
        case 'plan-clear':
          if (!confirm('Set every monthly budget back to zero?')) return;
          cats.filter((c) => Number(c.budget) > 0).forEach((c) => store.update('categories', c.id, { budget: 0 }));
          return;
        case 'add-cat': return catModal(null);
        case 'edit-cat': return catModal(cats.find((c) => c.id === id));
        default: return;
      }
      refresh();
    });

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.plan !== undefined) {
        const v = t.value.trim() === '' ? 0 : parseAmount(t.value);
        if (!(v >= 0)) { toast('Enter a number'); return; }
        holdRedraw();
        store.update('categories', t.dataset.plan, { budget: v });
      } else if (t.dataset.planIncome !== undefined) {
        const v = t.value.trim() === '' ? 0 : parseAmount(t.value);
        if (!(v >= 0)) { toast('Enter a number'); return; }
        holdRedraw();
        saveSetting('budget', { income: v });
      } else if (t.dataset.planBigOn !== undefined) {
        saveSetting('budget', { bigOn: t.checked, bigAmount: Number(settings.budget?.bigAmount) || 200 });
        toast(t.checked ? 'Large purchase alerts on' : 'Large purchase alerts off');
      } else if (t.dataset.planBigAmount !== undefined) {
        const v = parseAmount(t.value);
        if (!(v > 0)) { toast('Enter an amount above zero'); return; }
        holdRedraw();
        saveSetting('budget', { bigAmount: v });
      } else if (t.dataset.planAlertsOn !== undefined) {
        saveSetting('budget', { alertsOn: t.checked });
        toast(t.checked ? 'Limit alerts on' : 'Limit alerts off');
      } else if (t.dataset.planAlert !== undefined) {
        saveSetting('budget', { alertAt: Number(t.value) / 100 });
        toast(`Alerts at ${t.value}%`);
      }
    });

    root.addEventListener('input', (e) => {
      const k = e.target.dataset.input;
      if (k === 'search') { ui.search = e.target.value; draw(); }
      if (k === 'cat') { ui.cat = e.target.value; draw(); }
      if (k === 'period') {
        // Keep roughly the same place in time when switching period types.
        const before = currentRange();
        const thisYear = todayISO().slice(0, 4);
        ui.period = e.target.value;
        if (ui.period === 'year') ui.year = before.to.slice(0, 4) > thisYear ? thisYear : before.to.slice(0, 4);
        if (ui.period === 'month') ui.month = before.to > todayISO() ? monthKey(new Date()) : before.to.slice(0, 7);
        if (ui.period === 'custom') { ui.from = before.from; ui.to = before.to; }
        refresh();
      }
      if ((k === 'from' || k === 'to') && e.target.value) { ui[k] = e.target.value; refresh(); }
    });

    // Chart hover / tap tooltip.
    const showTip = (e) => {
      const col = e.target.closest?.('.col');
      const wrap = e.target.closest?.('.chart-wrap');
      if (!wrap) return;
      const tip = wrap.querySelector('.tooltip');
      wrap.querySelectorAll('.col.hover').forEach((c) => c !== col && c.classList.remove('hover'));
      if (!col) { tip.hidden = true; return; }
      col.classList.add('hover');
      const d = JSON.parse(wrap.dataset.chart)[col.dataset.i];
      tip.innerHTML = `
        <div class="tip-title">${esc(monthLabel(d.m))}</div>
        <div><i class="sw income"></i>Income <b>${money(d.income)}</b></div>
        <div><i class="sw spent"></i>Spent <b>${money(d.spent)}</b></div>
        <div class="tip-net">Net <b>${money(d.income - d.spent, { sign: true })}</b></div>`;
      tip.hidden = false;
      const r = wrap.getBoundingClientRect();
      const x = e.clientX - r.left;
      tip.style.left = `${Math.min(Math.max(x - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth)}px`;
      tip.style.top = `${Math.max(e.clientY - r.top - tip.offsetHeight - 12, 0)}px`;
    };
    root.addEventListener('pointermove', showTip);
    root.addEventListener('pointerdown', showTip);
    root.addEventListener('pointerleave', () => {
      root.querySelectorAll('.tooltip').forEach((t) => { t.hidden = true; });
      root.querySelectorAll('.col.hover').forEach((c) => c.classList.remove('hover'));
    });

    sortable(root, {
      list: '.plan-list', item: '.plan-row', handle: '.drag-handle', onDrop: reorderPlan,
      onStart: () => { dragging = true; },
      onEnd: () => { dragging = false; if (dirty) { dirty = false; draw(); } },
    });

    refresh();
    return () => unsubs.forEach((u) => u());
  },
};

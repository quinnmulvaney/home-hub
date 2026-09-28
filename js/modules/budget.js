import * as store from '../store.js';
import {
  esc, money, parseAmount, todayISO, monthKey, addMonths, monthLabel, dayLabel,
  openModal, closeModal, toast, renderKeepingFocus, pref, setPref, newId,
} from '../util.js';
import { merchantKey, suggestRule, ruleMatches } from '../merchant.js';

// Data model (both collections live under the household):
//   categories:   { name, icon, type: 'expense'|'income', budget (monthly), order, archived }
//   transactions: { date 'YYYY-MM-DD', amount (expense < 0 = refund), type, categoryId, note, account?, source?, createdAt, createdBy }
store.registerCollections(['categories', 'transactions', 'rules', 'accounts']);

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
const ui = { month: monthKey(new Date()), tab: pref('budgetTab', 'overview'), search: '', cat: '' };

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

    const unsubs = [
      store.subscribe('categories', (list) => { cats = sortCats(list); catById = new Map(cats.map((c) => [c.id, c])); draw(); }),
      store.subscribe('transactions', (list) => { txs = list; draw(); }),
      store.subscribe('accounts', (list) => { accounts = list; draw(); }),
      store.subscribe('bankSync', (list) => { bankStatus = list.find((d) => d.id === 'status') || null; draw(); }),
      store.subscribe('rules', (list) => { rules = list; }),
    ];

    function draw() {
      const monthTx = txs.filter((t) => t.date?.startsWith(ui.month));
      const body = ui.tab === 'transactions' ? transactionsTab(monthTx)
        : ui.tab === 'categories' ? categoriesTab()
        : overviewTab(monthTx);
      renderKeepingFocus(root, `
        <div class="toolbar">
          <div class="month-bar">
            <button class="icon-btn" data-action="prev-month" aria-label="Previous month">‹</button>
            <button class="month-label" data-action="this-month" title="Jump to this month">${esc(monthLabel(ui.month))}</button>
            <button class="icon-btn" data-action="next-month" aria-label="Next month">›</button>
          </div>
          <div class="tabs" role="tablist">
            ${[['overview', 'Overview'], ['transactions', 'Transactions'], ['categories', 'Categories']].map(([id, label]) =>
              `<button role="tab" class="tab ${ui.tab === id ? 'active' : ''}" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
          </div>
        </div>
        ${body}
        <button class="fab" data-action="add-tx" aria-label="Add transaction" title="Add transaction">+</button>`);
    }

    // ---------- Overview ----------

    function overviewTab(monthTx) {
      const income = sum(monthTx.filter((t) => t.type === 'income'));
      const expenses = monthTx.filter((t) => t.type !== 'income');
      const spent = sum(expenses);
      const budgetCats = cats.filter((c) => c.type === 'expense' && !c.archived);
      const totalBudget = budgetCats.reduce((s, c) => s + (Number(c.budget) || 0), 0);
      const left = totalBudget - spent;

      const rows = cats.filter((c) => c.type === 'expense').map((c) => {
        const catSpent = sum(expenses.filter((t) => t.categoryId === c.id));
        return { c, spent: catSpent, budget: Number(c.budget) || 0 };
      }).filter((r) => r.budget > 0 || r.spent > 0);
      const uncategorized = sum(expenses.filter((t) => !catById.has(t.categoryId)));
      if (uncategorized > 0) rows.push({ c: { id: '', name: 'Uncategorized', icon: '❔' }, spent: uncategorized, budget: 0 });

      // "Pace" marker: how far through the month we are, only for the current month.
      const now = new Date();
      const isCurrent = ui.month === monthKey(now);
      const pace = isCurrent ? now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() : null;

      const reviewCount = txs.filter((t) => t.needsReview).length;
      return `
        ${reviewCount ? `
          <button class="review-banner" data-action="show-review">
            <span>⚠ <b>${reviewCount}</b> bank transaction${reviewCount === 1 ? '' : 's'} need${reviewCount === 1 ? 's' : ''} a category</span>
            <span class="review-go">Review ›</span>
          </button>` : ''}
        <div class="tiles">
          ${tile('Income', money(income))}
          ${tile('Spent', money(spent))}
          ${totalBudget > 0
            ? tile(left >= 0 ? 'Left to spend' : 'Over budget', money(Math.abs(left)), `of ${money(totalBudget)} budgeted`, left < 0 ? 'bad' : '')
            : tile('Left to spend', '—', 'Set budgets in Categories')}
          ${tile('Net', money(income - spent, { sign: true }), income - spent >= 0 ? 'Saved this month' : 'More out than in')}
        </div>

        <section class="card">
          <div class="card-head">
            <h2>Spending by category</h2>
            ${isCurrent ? '<span class="muted small" title="The line on each bar shows how far through the month we are">│ = today</span>' : ''}
          </div>
          ${rows.length ? `<div class="budget-list">${rows.map((r) => budgetRow(r, pace)).join('')}</div>`
            : `<p class="muted">No spending yet this month. Tap <b>+</b> to add a transaction${totalBudget ? '' : ', and set monthly budgets under <b>Categories</b>'}.</p>`}
        </section>

        ${accountsCard()}

        <section class="card">
          <div class="card-head"><h2>Last 6 months</h2></div>
          ${trendChart()}
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

    function trendChart() {
      const months = [-5, -4, -3, -2, -1, 0].map((d) => addMonths(ui.month, d));
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
            <text x="${cx}" y="${H - 6}" class="axis ${d.m === ui.month ? 'current' : ''}" text-anchor="middle">${esc(monthLabel(d.m, { month: 'short' }))}</text>
            <rect class="hit" x="${L + groupW * i}" y="0" width="${groupW}" height="${H}"/>
          </g>`;
      }).join('');

      return `
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

    // ---------- Transactions ----------

    function transactionsTab(monthTx) {
      const q = ui.search.trim().toLowerCase();
      const reviewing = ui.cat === REVIEW;
      const reviewCount = txs.filter((t) => t.needsReview).length;
      const list = (reviewing ? txs.filter((t) => t.needsReview) : monthTx)
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
        : `<div class="empty small"><p>No transactions${ui.cat || q ? ' match your filter' : ` in ${esc(monthLabel(ui.month, { month: 'long' }))}`}.</p>
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
      const defaultDate = ui.month === monthKey(new Date()) ? todayISO() : `${ui.month}-01`;
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
        if (!editing && !data.date.startsWith(ui.month)) { ui.month = data.date.slice(0, 7); draw(); }
      };
    }

    // Remember merchant -> category, and apply it to other rows from that merchant still awaiting review.
    function saveRule(key, data, exceptId) {
      const existing = rules.find((r) => r.match === key);
      const rule = { match: key, categoryId: data.categoryId, type: data.type };
      if (existing) store.update('rules', existing.id, rule);
      else store.add('rules', rule);
      const others = txs.filter((t) => t.id !== exceptId && t.needsReview && ruleMatches(key, t.note));
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
        case 'prev-month': ui.month = addMonths(ui.month, -1); break;
        case 'next-month': ui.month = addMonths(ui.month, 1); break;
        case 'this-month': ui.month = monthKey(new Date()); break;
        case 'tab': ui.tab = b.dataset.tab; setPref('budgetTab', ui.tab); break;
        case 'filter-cat': ui.cat = id; ui.search = ''; ui.tab = 'transactions'; break;
        case 'clear-filter': ui.cat = ''; ui.search = ''; break;
        case 'show-review': ui.cat = REVIEW; ui.search = ''; ui.tab = 'transactions'; break;
        case 'add-tx': return txModal(null);
        case 'edit-tx': return txModal(txs.find((t) => t.id === id));
        case 'add-cat': return catModal(null);
        case 'edit-cat': return catModal(cats.find((c) => c.id === id));
        default: return;
      }
      draw();
    });

    root.addEventListener('input', (e) => {
      const k = e.target.dataset.input;
      if (k === 'search') { ui.search = e.target.value; draw(); }
      if (k === 'cat') { ui.cat = e.target.value; draw(); }
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

    draw();
    return () => unsubs.forEach((u) => u());
  },
};

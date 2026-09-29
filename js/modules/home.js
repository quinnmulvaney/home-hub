import * as store from '../store.js';
import { esc, money, todayISO, monthKey, monthLabel } from '../util.js';
import { goalStatus, weddingSummary, spendByCategory, round2, sumBy } from '../stats.js';
import { computeAlerts, alertMessage, DEFAULT_ALERT_AT } from '../alerts.js';
import { countdownHtml, startCountdown } from '../countdown.js';
import { ring } from '../charts.js';

store.registerCollections(['categories', 'transactions', 'settings', 'goals', 'contributions', 'weddingItems']);

export default {
  id: 'home',
  title: 'Home',
  icon: '🏠',
  render(el) {
    const root = document.createElement('div');
    root.className = 'home';
    el.appendChild(root);

    let cats = [], goals = [], contribs = [], settings = {}, wItems = [], monthTx = [], reviewTx = [];
    let stopCountdown = () => {};

    function draw() {
      stopCountdown();
      const month = monthKey(new Date());
      const wedding = settings.wedding || {};
      const expenses = monthTx.filter((t) => t.type !== 'income');
      const spent = sumBy(expenses);
      const income = sumBy(monthTx.filter((t) => t.type === 'income'));
      const budgeted = round2(cats.filter((c) => c.type === 'expense' && !c.archived).reduce((t, c) => t + (Number(c.budget) || 0), 0));
      const left = round2(budgeted - spent);
      const b = settings.budget || {};
      const alerts = computeAlerts(cats, spendByCategory(monthTx, month), Number(b.alertAt) || DEFAULT_ALERT_AT, b.alertsOn !== false);
      const today = todayISO();
      const dayPct = Number(today.slice(8, 10)) / new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();

      root.innerHTML = `
        ${heroCard(wedding)}
        <section class="card">
          <div class="card-head"><h2>${esc(monthLabel(month))}</h2><a class="link" href="#/budget">Open budget ›</a></div>
          ${budgeted > 0 ? `
            <div class="home-money">
              <div><span class="muted small">Spent</span><b>${money(spent)}</b></div>
              <div><span class="muted small">${left >= 0 ? 'Left to spend' : 'Over budget'}</span><b class="${left < 0 ? 'bad' : ''}">${money(Math.abs(left))}</b></div>
              <div><span class="muted small">Income</span><b>${money(income)}</b></div>
            </div>
            <div class="bar" role="progressbar" aria-valuenow="${Math.round(Math.min(spent / budgeted, 1) * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Spent of monthly budget">
              <span class="fill ${spent > budgeted ? 'over' : ''}" style="width:${Math.min(Math.max(spent / budgeted, 0), 1) * 100}%"></span>
              <span class="pace" style="left:${dayPct * 100}%"></span>
            </div>
            <p class="muted small home-note">${money(spent)} of ${money(budgeted)} budgeted · the line shows how far through the month you are</p>`
          : `<div class="home-money">
              <div><span class="muted small">Spent</span><b>${money(spent)}</b></div>
              <div><span class="muted small">Income</span><b>${money(income)}</b></div>
            </div>
            <p class="muted small home-note">No monthly budgets yet. <a href="#/budget">Set them up in Budget → Plan</a>.</p>`}
          ${alerts.length ? `<div class="alerts">${alerts.slice(0, 3).map((a) => `
            <a class="alert-row ${a.level}" href="#/budget"><span>${a.level === 'over' ? '🚨' : '⚠️'} ${esc(alertMessage(a))}</span><span class="review-go">View ›</span></a>`).join('')}</div>` : ''}
          ${reviewTx.length ? `<a class="review-banner" href="#/budget"><span>⚠ <b>${reviewTx.length}</b> bank transaction${reviewTx.length === 1 ? '' : 's'} need${reviewTx.length === 1 ? 's' : ''} a category</span><span class="review-go">Review ›</span></a>` : ''}
        </section>
        ${goalsCard(wedding)}`;
      stopCountdown = startCountdown(root);
    }

    function heroCard(wedding) {
      if (!wedding.date) {
        return `
          <section class="card hero">
            <div class="hero-eyebrow">💍 Our wedding</div>
            <p class="hero-empty">Set your wedding date to start the countdown and plan the savings.</p>
            <a class="btn hero-btn" href="#/wedding">Open wedding planner</a>
          </section>`;
      }
      const w = weddingSummary(wedding, wItems, contribs);
      const pct = w.total > 0 ? Math.min(Math.max(1 - w.remaining / w.total, 0), 1) : 0;
      return `
        <section class="card hero">
          <div class="hero-eyebrow">💍 Our wedding</div>
          ${countdownHtml(wedding.date)}
          ${w.total > 0 ? `<a class="hero-fund" href="#/wedding">
            <span class="hero-bar"><span style="width:${pct * 100}%"></span></span>
            <span>${Math.round(pct * 100)}% funded${w.neededPerMonth ? ` · save ${money(w.neededPerMonth)}/mo` : w.done ? ' · fully funded 🎉' : ''} ›</span></a>` : '<a class="hero-fund" href="#/wedding"><span>Add your costs to plan the savings ›</span></a>'}
        </section>`;
    }

    function goalsCard(wedding) {
      const list = goals.filter((g) => !g.archived)
        .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (a.createdDate || '').localeCompare(b.createdDate || ''));
      const items = list.map((g) => ({ name: g.name, icon: g.icon || '🎯', st: goalStatus(g, contribs) }));
      if (wedding.date || wItems.length) {
        const w = weddingSummary(wedding, wItems, contribs);
        items.unshift({ name: 'Wedding fund', icon: '💍', st: { saved: Math.max(w.total - w.remaining, 0), target: w.total, pct: w.total > 0 ? Math.min(Math.max(1 - w.remaining / w.total, 0), 1) : 0, neededPerMonth: w.neededPerMonth, done: w.done } });
      }
      if (!items.length) {
        return `
          <section class="card">
            <div class="card-head"><h2>Goals</h2><a class="link" href="#/goals">Add a goal ›</a></div>
            <p class="muted">Emergency fund, debt payoff, a trip. Set a goal and Home Hub works out what to set aside each month.</p>
          </section>`;
      }
      const saved = round2(items.reduce((t, i) => t + i.st.saved, 0));
      const target = round2(items.reduce((t, i) => t + i.st.target, 0));
      const need = round2(items.reduce((t, i) => t + (i.st.neededPerMonth || 0), 0));
      const pct = target > 0 ? saved / target : 0;
      return `
        <section class="card">
          <div class="card-head"><h2>Goals</h2><a class="link" href="#/goals">All goals ›</a></div>
          <div class="summary-top">
            ${ring(pct, `${Math.round(pct * 100)}%`, 'overall')}
            <div class="mini-goals">
              ${items.slice(0, 4).map((i) => `
                <div class="mini-goal">
                  <div class="mini-top"><span>${esc(i.icon)} ${esc(i.name)}</span><b>${Math.round(i.st.pct * 100)}%</b></div>
                  <div class="bar progress"><span class="fill ${i.st.done ? 'done' : ''}" style="width:${i.st.pct * 100}%"></span></div>
                </div>`).join('')}
            </div>
          </div>
          ${need > 0 ? `<p class="muted small home-note">Set aside about <b>${money(need)}</b> this month to stay on track.</p>` : ''}
        </section>`;
    }

    const unsubs = [
      store.subscribe('categories', (l) => { cats = l; draw(); }),
      store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); draw(); }),
      store.subscribe('goals', (l) => { goals = l; draw(); }),
      store.subscribe('contributions', (l) => { contribs = l; draw(); }),
      store.subscribe('weddingItems', (l) => { wItems = l; draw(); }),
      store.subscribeWhere('transactions', [['date', '>=', `${monthKey(new Date())}-01`]], (l) => { monthTx = l; draw(); }),
      store.subscribeWhere('transactions', [['needsReview', '==', true]], (l) => { reviewTx = l; draw(); }),
    ];

    draw();
    return () => { stopCountdown(); unsubs.forEach((u) => u()); };
  },
};

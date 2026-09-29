import * as store from '../store.js';
import { esc, money, todayISO, monthKey, monthLabel, parseAmount, toast, toastUndo, renderKeepingFocus } from '../util.js';
import { goalStatus, weddingSummary, spendByCategory, round2, sumBy, upcomingBills, weekSummary, addDaysISO, daysBetweenISO } from '../stats.js';
import { computeAlerts, alertMessage, computeBigPurchases, bigMessage, bigSettings, subscribeRecent, DEFAULT_ALERT_AT } from '../alerts.js';
import { countdownHtml, startCountdown } from '../countdown.js';
import { ring } from '../charts.js';
import { dayEvents, involves, fmtTime } from '../events.js';
import { subscribePeople, roster, personById, initial } from '../people.js';
import { acceptTask, declineTask } from '../tasks.js';

store.registerCollections(['categories', 'transactions', 'settings', 'goals', 'contributions', 'weddingItems', 'calendars', 'events', 'tasks', 'statuses']);

export default {
  id: 'home',
  title: 'Home',
  icon: '🏠',
  render(el) {
    const root = document.createElement('div');
    root.className = 'home';
    el.appendChild(root);

    let cats = [], goals = [], contribs = [], settings = {}, wItems = [], monthTx = [], recentTx = [], reviewTx = [], bills = [], calendars = [], events = [], tasks = [], statuses = [];
    const quick = { amount: '', note: '' };   // survives redraws while you type
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
      const big = bigSettings(settings);
      const bigList = big.on ? computeBigPurchases(cats, recentTx, { amount: big.amount }) : [];
      const today = todayISO();
      const dayPct = Number(today.slice(8, 10)) / new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();

      renderKeepingFocus(root, `
        ${heroCard(wedding)}
        ${todayCard()}
        ${quickAddCard()}
        ${upcomingCard()}
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
          ${bigList.length ? `<div class="alerts">${bigList.map((p) => `
            <a class="alert-row big" href="#/budget"><span>💳 Large purchase: ${esc(bigMessage(p))}</span><span class="review-go">View ›</span></a>`).join('')}</div>` : ''}
          ${reviewTx.length ? `<a class="review-banner" href="#/budget"><span>⚠ <b>${reviewTx.length}</b> bank transaction${reviewTx.length === 1 ? '' : 's'} need${reviewTx.length === 1 ? 's' : ''} a category</span><span class="review-go">Review ›</span></a>` : ''}
        </section>
        ${weekCard()}
        ${goalsCard(wedding)}`);
      stopCountdown = startCountdown(root);
    }

    // ---------- today: what's on for you (work calendars left out, like the morning summary) ----------
    function todayCard() {
      const today = todayISO();
      const meId = store.meId();
      const sts = roster().map((p) => ({ p, st: statuses.find((x) => x.uid === p.id && x.date === today) })).filter((x) => x.st);
      const evs = dayEvents(events, calendars, today).filter((it) => !it.cal?.hideFromDigest && involves(it.assignees, it.cal, meId));
      const mine = tasks.filter((t) => t.assignee === meId && t.status !== 'done' && (!t.due || t.due <= today))
        .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 6);
      if (!evs.length && !mine.length && !sts.length) return '';
      return `
        <section class="card">
          <div class="card-head"><h2>Today</h2><a class="link" href="#/calendar">Calendar ›</a></div>
          ${sts.length ? `<div class="status-row home-status">${sts.map(({ p, st }) => `<span class="status-chip" style="--pc:${esc(p.color || '#888')}"><b>${esc(initial(p))}</b>${st.emoji ? `<span aria-hidden="true">${esc(st.emoji)}</span>` : ''} ${esc(st.text)}</span>`).join('')}</div>` : ''}
          ${evs.map((it) => {
            const turn = it.ev.rotation?.order?.length && it.assignees[0] ? (it.assignees[0] === meId ? 'Your turn' : `${personById(it.assignees[0]).name}'s turn`) : '';
            return `<div class="agenda-item" style="--cc:${esc(it.cal?.color || '#888')}">
              <span class="agenda-main"><span class="agenda-time">${it.ev.start ? esc(fmtTime(it.ev.start)) : 'All day'}</span>
                <span class="agenda-title">${esc(it.ev.title)} ${turn ? `<span class="turn ${it.assignees[0] === meId ? 'mine' : ''}">${esc(turn)}</span>` : ''}</span></span></div>`;
          }).join('')}
          ${mine.map((t) => `
            <div class="task">
              <span class="task-main"><span class="task-title" style="cursor:default">${esc(t.title)}</span>
                <span class="task-meta">${t.status === 'pending' ? `<span class="small muted">from ${esc(personById(t.assignedBy).name)}</span>` : ''}${t.due && t.due < today ? '<span class="st late">Overdue</span>' : ''}</span></span>
              ${t.status === 'pending' ? `<span class="task-actions"><button class="btn sm primary" data-home-accept="${esc(t.id)}">Accept</button><button class="btn sm" data-home-decline="${esc(t.id)}">Not today</button></span>` : ''}
            </div>`).join('')}
        </section>`;
    }

    // ---------- quick add ----------
    function quickCats() {
      const since = addDaysISO(todayISO(), -60);
      const counts = {};
      for (const t of recentTx) if (t.type !== 'income' && t.date >= since) counts[t.categoryId] = (counts[t.categoryId] || 0) + 1;
      return cats.filter((c) => c.type === 'expense' && !c.archived)
        .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || (a.order ?? 999) - (b.order ?? 999)).slice(0, 6);
    }

    function quickAddCard() {
      const list = quickCats();
      if (!list.length) return '';
      return `
        <section class="card quick">
          <div class="card-head"><h2>Quick add</h2><a class="link" href="#/budget">Full form ›</a></div>
          <div class="quick-row">
            <div class="money-input"><span>$</span><input class="input amount" inputmode="decimal" placeholder="0.00" value="${esc(quick.amount)}" data-quick="amount" data-focus-key="quick-amount" aria-label="Amount"></div>
            <input class="input" placeholder="What was it? (optional)" maxlength="60" value="${esc(quick.note)}" data-quick="note" data-focus-key="quick-note" aria-label="Note">
          </div>
          <div class="quick-cats" role="group" aria-label="Pick a category to save">
            ${list.map((c) => `<button class="qcat" data-quick-cat="${esc(c.id)}"><span aria-hidden="true">${esc(c.icon || '📦')}</span>${esc(c.name)}</button>`).join('')}
          </div>
          <p class="muted small home-note">Type an amount, then tap a category to save it as today's expense.</p>
        </section>`;
    }

    // ---------- bills coming up ----------
    function upcomingCard() {
      const live = bills.filter((b) => b.active !== false);
      if (!live.length) return '';
      const today = todayISO();
      const items = upcomingBills(live, recentTx, today, 14, 7).slice(0, 5);
      if (!items.length) return '';
      const when = (due) => {
        const n = daysBetweenISO(today, due);
        return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 ? `In ${n} days` : `${-n} day${n === -1 ? '' : 's'} ago`;
      };
      const text = { paid: 'Paid', auto: 'Autopay', late: 'Overdue', soon: 'Due soon', due: 'Upcoming' };
      return `
        <section class="card">
          <div class="card-head"><h2>Bills coming up</h2><a class="link" href="#/calendar">Calendar ›</a></div>
          <div class="upcoming">${items.map((i) => `
            <a class="bill" href="#/calendar" style="text-decoration:none;color:inherit">
              <span class="bill-main"><span class="bill-name">${esc(i.bill.name)}</span><span class="small muted">${esc(when(i.due))}</span></span>
              <span class="st ${i.status}">${text[i.status]}</span>
              <span class="bill-amt">${money(i.bill.amount)}</span>
            </a>`).join('')}</div>
        </section>`;
    }

    // ---------- this week ----------
    function weekCard() {
      const w = weekSummary(recentTx, cats, todayISO());
      if (!w.count && !w.prevSpent) return '';
      const change = w.delta == null ? '' : Math.abs(w.delta) > 2 ? money(Math.abs(w.spent - w.prevSpent)) : `${Math.round(Math.abs(w.delta) * 100)}%`;
      const delta = w.delta == null ? '' : `<span class="week-delta ${w.delta > 0 ? 'up' : 'down'}">${w.delta > 0 ? '▲' : '▼'} ${change}</span> vs last week`;
      return `
        <section class="card">
          <div class="card-head"><h2>This week</h2><span class="muted small">Monday to today</span></div>
          <div class="home-money">
            <div><span class="muted small">Spent</span><b>${money(w.spent)}</b></div>
            <div><span class="muted small">Last week (same days)</span><b>${money(w.prevSpent)}</b></div>
            <div><span class="muted small">Purchases</span><b>${w.count}</b></div>
          </div>
          <p class="home-note small">${delta}${w.top ? `${delta ? ' · ' : ''}Top: <b>${esc(w.top.name)}</b> ${money(w.top.amount)}` : ''}${w.biggest ? ` · Biggest: <b>${esc(w.biggest.note)}</b> ${money(w.biggest.amount)}` : ''}</p>
        </section>`;
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
      store.subscribe('bills', (l) => { bills = l; draw(); }),
      store.subscribe('calendars', (l) => { calendars = l; draw(); }),
      store.subscribe('events', (l) => { events = l; draw(); }),
      store.subscribe('tasks', (l) => { tasks = l; draw(); }),
      store.subscribe('statuses', (l) => { statuses = l; draw(); }),
      subscribePeople(() => draw()),
      store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); draw(); }),
      store.subscribe('goals', (l) => { goals = l; draw(); }),
      store.subscribe('contributions', (l) => { contribs = l; draw(); }),
      store.subscribe('weddingItems', (l) => { wItems = l; draw(); }),
      // Shared with the alert monitor, so the last few months aren't downloaded twice.
      subscribeRecent((l) => { recentTx = l; monthTx = l.filter((t) => t.date?.startsWith(monthKey(new Date()))); draw(); }),
      store.subscribeWhere('transactions', [['needsReview', '==', true]], (l) => { reviewTx = l; draw(); }),
    ];

    root.addEventListener('input', (e) => {
      const k = e.target.dataset.quick;
      if (k) quick[k] = e.target.value;
    });
    root.addEventListener('click', (e) => {
      const acc = e.target.closest('[data-home-accept]');
      if (acc) { acceptTask(acc.dataset.homeAccept); toast('Accepted. It is on your day.'); return; }
      const dec = e.target.closest('[data-home-decline]');
      if (dec) { const t = tasks.find((x) => x.id === dec.dataset.homeDecline); if (t) { declineTask(t); toast('Passed back'); } return; }
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-quick-cat]');
      if (!b) return;
      const amount = parseAmount(quick.amount);
      if (!(amount > 0)) { toast('Type an amount first'); root.querySelector('[data-quick=amount]')?.focus(); return; }
      const cat = cats.find((c) => c.id === b.dataset.quickCat);
      const id = store.add('transactions', {
        date: todayISO(), type: 'expense', amount, categoryId: b.dataset.quickCat, note: quick.note.trim(),
        source: 'manual', createdAt: Date.now(), createdBy: store.getState().user?.email || '',
      });
      quick.amount = '';
      quick.note = '';
      draw();
      toastUndo(`Added ${money(amount)} to ${cat?.name || 'category'}`, () => store.remove('transactions', id));
    });

    draw();
    return () => { stopCountdown(); unsubs.forEach((u) => u()); };
  },
};

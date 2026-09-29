import * as store from '../store.js';
import {
  esc, money, parseAmount, todayISO, monthKey, addMonths, monthLabel, openModal, closeModal, toast, renderKeepingFocus,
} from '../util.js';
import {
  averages, spendByCategory, roundUps, recurring, goalStatus, contributionStreak, underBudgetStreak, amortize,
  addMonthsISO, monthsUntil, round2, sumBy, weddingSummary, isEssential, WEDDING_ID,
} from '../stats.js';
import { lineChart, ring } from '../charts.js';

// goals:         { name, icon, type: 'savings'|'emergency'|'debt', target, startAmount, deadline?, monthly?, apr?, createdDate, archived }
// contributions: { goalId, date, amount, note }  (debt: payments toward principal; negative = money taken out)
store.registerCollections(['goals', 'contributions', 'categories', 'settings', 'weddingItems']);

const TYPES = {
  savings: { label: 'Savings goal', icon: '🎯' },
  emergency: { label: 'Emergency fund', icon: '🛟' },
  debt: { label: 'Debt payoff', icon: '💳' },
};
const STARTERS = [
  { type: 'emergency', name: 'Emergency fund', icon: '🛟' },
  { type: 'debt', name: 'Pay off debt', icon: '💳' },
  { type: 'savings', name: 'Vacation', icon: '✈️' },
  { type: 'savings', name: 'Down payment', icon: '🏡' },
  { type: 'savings', name: 'New car', icon: '🚗' },
  { type: 'savings', name: 'Custom goal', icon: '🎯' },
];
const EMOJI = ['🎯', '🛟', '💳', '✈️', '🏡', '🚗', '🎓', '💍', '👶', '🏖️', '🛠️', '📈', '🐶', '🎁', '💻', '🏝️'];
const MILESTONES = [25, 50, 75, 100];
const nowMonth = () => monthKey(new Date());
const fmtMonth = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const fmtDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Survives switching tabs.
const ui = { whatifCat: '', whatifPct: 15, windfall: '', windfallFun: true, ideasOpen: true };

export default {
  id: 'goals',
  title: 'Goals',
  icon: '🎯',
  render(el) {
    const root = document.createElement('div');
    root.className = 'goals';
    el.appendChild(root);

    let goals = [], contribs = [], cats = [], txs = [], settings = {}, wItems = [];


    const active = () => goals.filter((g) => !g.archived).sort((a, b) => (a.createdDate || '').localeCompare(b.createdDate || ''));
    const hasWedding = () => !!(settings.wedding?.date || wItems.length);
    const wedding = () => weddingSummary(settings.wedding, wItems, contribs);
    const avg = () => averages(txs, cats, 3);
    const saveSetting = (id, patch) => store.put('settings', id, { ...(settings[id] || {}), ...patch });
    const fundName = (id) => (id === WEDDING_ID ? 'Wedding fund' : goals.find((g) => g.id === id)?.name || 'Goal');


    // ---------- rendering ----------

    function draw() {
      const list = active();
      const stats = new Map(list.map((g) => [g.id, goalStatus(g, contribs)]));
      renderKeepingFocus(root, `
        ${summaryCard(list, stats)}
        ${list.map((g) => goalCard(g, stats.get(g.id))).join('')}
        ${hasWedding() ? weddingCard() : ''}
        <div class="btn-row goal-add">
          <button class="btn primary" data-action="new-goal">+ New goal</button>
          ${hasWedding() ? '' : '<a class="btn" href="#/wedding">💍 Plan a wedding</a>'}
        </div>
        ${list.length || hasWedding() ? ideasSection(list, stats) : ''}`);
    }

    function summaryCard(list, stats) {
      const items = list.map((g) => ({ saved: stats.get(g.id).saved, target: stats.get(g.id).target, need: stats.get(g.id).neededPerMonth || 0, done: stats.get(g.id).done }));
      if (hasWedding()) {
        const w = wedding();
        items.push({ saved: Math.max(w.total - w.remaining, 0), target: w.total, need: w.neededPerMonth || 0, done: w.done });
      }
      if (!items.length) {
        return `
          <section class="card intro">
            <h2>Set a goal, then make it small</h2>
            <p class="muted">Pick something to start. Home Hub works out how much to set aside each month, tracks your progress, and finds ways to get there sooner.</p>
            <div class="starters">${STARTERS.map((s, i) => `<button class="starter" data-action="new-goal" data-starter="${i}"><span>${s.icon}</span>${esc(s.name)}</button>`).join('')}</div>
          </section>`;
      }
      const saved = round2(items.reduce((t, i) => t + i.saved, 0));
      const target = round2(items.reduce((t, i) => t + i.target, 0));
      const need = round2(items.reduce((t, i) => t + i.need, 0));
      const a = avg();
      const spare = a.months ? round2(a.income - a.spent) : null;
      const gap = spare === null ? null : round2(need - spare);
      const streak = underBudgetStreak(txs, cats);
      const pct = target > 0 ? saved / target : 0;
      return `
        <section class="card summary">
          <div class="summary-top">
            ${ring(pct, `${Math.round(pct * 100)}%`, 'overall')}
            <div>
              <div class="big">${money(saved)}</div>
              <div class="muted">of ${money(target)} across ${plural(items.length, 'goal')}</div>
              ${streak >= 1 ? `<div class="chip on streak">🔥 ${plural(streak, 'month')} under budget</div>` : ''}
            </div>
          </div>
          ${need > 0 ? `
            <div class="afford">
              <div class="afford-row"><span>Needed each month</span><b>${money(need)}</b></div>
              ${spare === null ? '' : `<div class="afford-row"><span>You typically have left over</span><b>${money(Math.max(spare, 0))}</b></div>
              <div class="alloc" role="img" aria-label="Monthly needed compared with what you have left over">
                <span class="alloc-seg goals" style="width:${Math.min(need / Math.max(need, spare, 1), 1) * 100}%"></span>
              </div>
              <p class="${gap > 0 ? 'bad' : 'good'} small">${gap > 0
                ? `You're about <b>${money(gap)}/month short</b>. The ideas below can close that gap without a big lifestyle change.`
                : `You can cover this with <b>${money(-gap)}</b> to spare each month. 🎉`}</p>`}
            </div>` : ''}
        </section>`;
    }

    function goalCard(g, st) {
      const debt = g.type === 'debt';
      const bar = Math.round(st.pct * 100);
      let line;
      if (st.done) line = debt ? '🎉 Paid off!' : '🎉 Goal reached!';
      else if (g.deadline) {
        line = `Needs <b>${money(st.neededPerMonth)}/mo</b> until ${fmtMonth(g.deadline)} · ${st.onTrack ? '<span class="good">✓ on track</span>'
          : st.projected ? `<span class="bad">behind, at your pace: ${fmtMonth(st.projected)}</span>` : '<span class="muted">no payments yet</span>'}`;
      } else if (st.projected) line = `At ${money(st.payment)}/mo you'll be there by <b>${fmtMonth(st.projected)}</b>`;
      else line = '<span class="muted">Add money to see when you\'ll get there</span>';
      const streak = contributionStreak(contribs, g.id);
      return `
        <article class="goal card ${st.done ? 'done' : ''}">
          <button class="goal-main" data-action="open-goal" data-id="${esc(g.id)}">
            <span class="goal-head">
              <span class="cat-icon" aria-hidden="true">${esc(g.icon || TYPES[g.type]?.icon || '🎯')}</span>
              <span class="goal-title"><span class="name">${esc(g.name)}</span><span class="muted small">${TYPES[g.type]?.label || 'Goal'}</span></span>
              <span class="goal-pct">${bar}%</span>
            </span>
            <span class="bar progress" role="progressbar" aria-valuenow="${bar}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(g.name)} progress"><span class="fill ${st.done ? 'done' : ''}" style="width:${bar}%"></span></span>
            <span class="goal-numbers"><span>${money(st.saved)} ${debt ? 'paid' : 'saved'}</span><span class="muted">${debt ? `${money(st.remaining)} left of ${money(st.target)}` : `of ${money(st.target)}`}</span></span>
            <span class="goal-line">${line}</span>
            <span class="chips">${MILESTONES.map((m) => `<span class="chip ${bar >= m ? 'on' : ''}">${m}%</span>`).join('')}${streak >= 2 ? `<span class="chip on">🔥 ${streak} months</span>` : ''}</span>
          </button>
          ${st.done ? '' : `<button class="btn primary sm" data-action="add-money" data-id="${esc(g.id)}">${debt ? 'Log payment' : 'Add money'}</button>`}
        </article>`;
    }

    function weddingCard() {
      const w = wedding();
      const bar = Math.round((w.total > 0 ? 1 - w.remaining / w.total : 0) * 100);
      return `
        <article class="goal card">
          <a class="goal-main" href="#/wedding">
            <span class="goal-head">
              <span class="cat-icon" aria-hidden="true">💍</span>
              <span class="goal-title"><span class="name">Wedding</span><span class="muted small">${settings.wedding?.date ? fmtDay(settings.wedding.date) : 'Set a date'}</span></span>
              <span class="goal-pct">${bar}%</span>
            </span>
            <span class="bar progress"><span class="fill" style="width:${bar}%"></span></span>
            <span class="goal-numbers"><span>${money(w.balance + w.paid)} funded</span><span class="muted">of ${money(w.total)}</span></span>
            <span class="goal-line">${w.done ? '🎉 Fully funded!' : w.neededPerMonth ? `Save <b>${money(w.neededPerMonth)}/mo</b> to be ready` : 'Open the planner for details'}</span>
          </a>
        </article>`;
    }

    // ---------- ways to get there faster ----------

    function ideasSection(list, stats) {
      const a = avg();
      const last = addMonths(nowMonth(), -1);
      const open = list.filter((g) => !stats.get(g.id).done);
      const target = open[0];
      const cards = [];

      // 1. Pay yourself first, per paycheck.
      const need = round2(open.reduce((t, g) => t + (stats.get(g.id).neededPerMonth || 0), 0) + (hasWedding() ? wedding().neededPerMonth || 0 : 0));
      if (need > 0) {
        const found = txs.filter((t) => t.type === 'income' && t.date?.startsWith(last) && /pay/i.test(cats.find((c) => c.id === t.categoryId)?.name || '')).length;
        const paychecks = found || 2;
        cards.push(idea('💸', 'Pay yourself first', `Set up an automatic transfer on payday: <b>${money(need / paychecks)}</b> per paycheck (about ${plural(paychecks, 'paycheck')} a month). Money you never see is money you don't spend.`));
      }

      // 2. Round-ups.
      const ru = roundUps(txs, last);
      if (ru.total >= 1) {
        cards.push(idea('🪙', 'Round-up jar', `Rounding every purchase up to the next dollar last month would have set aside <b>${money(ru.total)}</b> (from ${plural(ru.count, 'purchase')}). Try it: each week, move the round-ups.`,
          `<button class="btn sm" data-action="quick-add" data-amount="${ru.total}" data-note="Round-ups for ${esc(monthLabel(last))}">Move ${money(ru.total)} to a goal</button>`));
      }

      // 3. Leftover sweep.
      const spentLast = spendByCategory(txs, last);
      const leftover = round2(cats.filter((c) => c.type === 'expense' && !c.archived && Number(c.budget) > 0)
        .reduce((t, c) => t + Math.max(c.budget - (spentLast[c.id] || 0), 0), 0));
      if (leftover >= 5) {
        cards.push(idea('🧹', 'Sweep the leftovers', `You finished ${esc(monthLabel(last))} with <b>${money(leftover)}</b> unspent across your budgets. Unspent budget is easy to lose to next month. Move it to a goal instead.`,
          `<button class="btn sm" data-action="quick-add" data-amount="${leftover}" data-note="Leftover budget, ${esc(monthLabel(last))}">Move ${money(leftover)} to a goal</button>`));
      }

      // 4. What-if trim.
      const trimmable = cats.filter((c) => c.type === 'expense' && !c.archived && !isEssential(c.name) && (a.byCat[c.id] || 0) >= 15)
        .sort((x, y) => a.byCat[y.id] - a.byCat[x.id]).slice(0, 8);
      if (trimmable.length) {
        if (!trimmable.some((c) => c.id === ui.whatifCat)) ui.whatifCat = trimmable[0].id;
        cards.push(idea('✂️', 'What if I spend a little less?', `
          <div class="whatif">
            <select class="input" data-input="whatif-cat" aria-label="Category to trim">${trimmable.map((c) => `<option value="${esc(c.id)}" ${c.id === ui.whatifCat ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)} (avg ${money(a.byCat[c.id])}/mo)</option>`).join('')}</select>
            <label class="slider"><span>Spend <b class="whatif-pct">${ui.whatifPct}%</b> less</span><input type="range" min="5" max="50" step="5" value="${ui.whatifPct}" data-input="whatif-pct" aria-label="Percent to trim"></label>
            <div class="whatif-result">${whatifResult(a, target, stats)}</div>
          </div>`));
      }

      // 5. Subscriptions.
      const subs = recurring(txs, cats).slice(0, 6);
      if (subs.length) {
        const total = round2(subs.reduce((t, s) => t + s.monthly, 0));
        cards.push(idea('🔁', 'Recurring charges to review', `These repeat about every month at a steady price, <b>${money(total)}/mo</b> (${money(total * 12)}/yr) in total. Cancel or downgrade even one you barely use.
          <ul class="subs">${subs.map((s) => `<li><span>${esc(s.name)}</span><b>${money(s.monthly)}</b><span class="muted small">/mo · ${money(s.monthly * 12)}/yr</span></li>`).join('')}</ul>`));
      }

      // 6. Windfall splitter.
      cards.push(idea('🎁', 'Got a windfall?', `Tax refund, bonus, gift, side gig. Decide where it goes before it disappears.
        <div class="windfall">
          <div class="money-input"><span>$</span><input class="input" inputmode="decimal" placeholder="Amount" value="${esc(ui.windfall)}" data-input="windfall" data-focus-key="windfall" aria-label="Windfall amount"></div>
          <label class="check"><input type="checkbox" data-input="windfall-fun" ${ui.windfallFun ? 'checked' : ''}><span>Keep 10% to enjoy</span></label>
          <div class="windfall-result">${windfallPreview(open, stats)}</div>
        </div>`));

      // 7. 52-week challenge and 8. no-spend days.
      cards.push(challengeCard(open));
      cards.push(noSpendCard());

      return `
        <section class="ideas">
          <h2 class="section-title">Ways to get there faster</h2>
          ${cards.join('')}
        </section>`;
    }

    const idea = (icon, title, body, action = '') => `
      <section class="card idea"><div class="idea-head"><span class="idea-icon" aria-hidden="true">${icon}</span><h3>${esc(title)}</h3></div><div class="idea-body">${body}</div>${action}</section>`;

    function whatifResult(a, target, stats) {
      const c = cats.find((x) => x.id === ui.whatifCat);
      if (!c) return '';
      const cut = round2((a.byCat[c.id] || 0) * ui.whatifPct / 100);
      const newBudget = Math.round((a.byCat[c.id] || 0) - cut);
      let sooner = '';
      if (target) {
        const st = stats.get(target.id);
        const base = st.payment || st.neededPerMonth || 0;
        if (base > 0 && st.remaining > 0) {
          const m0 = Math.ceil(st.remaining / base), m1 = Math.ceil(st.remaining / (base + cut));
          if (m0 - m1 > 0) sooner = ` That would reach <b>${esc(target.name)}</b> <b>${plural(m0 - m1, 'month')} sooner</b>.`;
        } else if (st.remaining > 0) sooner = ` Put toward <b>${esc(target.name)}</b>, that's ${plural(Math.ceil(st.remaining / Math.max(cut, 1)), 'month')} to finish on that alone.`;
      }
      return `<p>Saves <b>${money(cut)}/month</b> (${money(cut * 12)}/year).${sooner}</p>
        <button class="btn sm" data-action="apply-trim" data-id="${esc(c.id)}" data-val="${newBudget}">Set ${esc(c.name)} budget to ${money(newBudget)}</button>`;
    }

    // Split by how much each goal still needs; optionally keep 10% as fun money.
    function windfallSplit(open) {
      const amount = parseAmount(ui.windfall);
      if (!(amount > 0)) return null;
      const pool = round2(ui.windfallFun ? amount * 0.9 : amount);
      const funds = open.map((g) => ({ id: g.id, name: g.name, remaining: goalStatus(g, contribs).remaining }));
      if (hasWedding() && wedding().remaining > 0) funds.push({ id: WEDDING_ID, name: 'Wedding fund', remaining: wedding().remaining });
      const total = funds.reduce((t, f) => t + f.remaining, 0);
      if (!funds.length || total <= 0) return { amount, pool, parts: [], fun: round2(amount - pool) };
      let parts = funds.map((f) => ({ ...f, share: round2(Math.min(pool * f.remaining / total, f.remaining)) }));
      const assigned = round2(parts.reduce((t, p) => t + p.share, 0));
      if (assigned < pool && parts.length) parts[0].share = round2(Math.min(parts[0].share + pool - assigned, parts[0].remaining));
      parts = parts.filter((p) => p.share > 0);
      return { amount, pool, parts, fun: round2(amount - parts.reduce((t, p) => t + p.share, 0)) };
    }
    function windfallPreview(open) {
      const s = windfallSplit(open);
      if (!s) return '<p class="muted small">Enter an amount to see a suggested split.</p>';
      if (!s.parts.length) return '<p class="muted small">Add a goal first and this can split across them.</p>';
      return `<ul class="subs">${s.parts.map((p) => `<li><span>${esc(p.name)}</span><b>${money(p.share)}</b></li>`).join('')}
        ${s.fun > 0 ? `<li><span>🎉 Just for you</span><b>${money(s.fun)}</b></li>` : ''}</ul>
        <button class="btn sm primary" data-action="apply-windfall">Add these to my goals</button>`;
    }

    // 52-week challenge: deposit N × multiplier in week N.
    function challengeCard(open) {
      const ch = settings.challenge;
      const fundsList = [...open.map((g) => [g.id, g.name]), ...(hasWedding() ? [[WEDDING_ID, 'Wedding fund']] : [])];
      if (!ch?.startDate) {
        return idea('📅', '52-week challenge', `Save $1 in week 1, $2 in week 2, and so on. The deposits start tiny and add up to <b>${money(1378)}</b> in a year (or ${money(2756)} at $2, ${money(6890)} at $5).
          <div class="inline challenge-start">
            <select class="input" data-input="ch-goal" aria-label="Goal to fund">${fundsList.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('')}</select>
            <select class="input" data-input="ch-mult" aria-label="Weekly step">${[1, 2, 5].map((m) => `<option value="${m}">+$${m}/week</option>`).join('')}</select>
            <button class="btn primary" data-action="start-challenge">Start</button>
          </div>`);
      }
      const weekNow = Math.min(52, Math.floor(Math.max(0, (Date.now() - new Date(`${ch.startDate}T12:00`).getTime()) / 864e5) / 7) + 1);
      const done = new Set(ch.done || []);
      const next = Array.from({ length: weekNow }, (_, i) => i + 1).find((w) => !done.has(w));
      const saved = [...done].reduce((t, w) => t + w * ch.mult, 0);
      const behind = Array.from({ length: weekNow }, (_, i) => i + 1).filter((w) => !done.has(w)).length;
      return idea('📅', '52-week challenge', `
        <div class="bar progress" role="progressbar" aria-valuenow="${done.size}" aria-valuemin="0" aria-valuemax="52"><span class="fill" style="width:${done.size / 52 * 100}%"></span></div>
        <p><b>${done.size} of 52</b> weeks done · ${money(saved)} saved toward <b>${esc(fundName(ch.goalId))}</b>${behind > 1 ? ` · ${plural(behind, 'week')} to catch up` : ''}</p>
        ${next ? `<button class="btn primary sm" data-action="log-week" data-week="${next}">Log week ${next} (${money(next * ch.mult)})</button>`
          : '<p class="good small">All caught up. See you next week! 🎉</p>'}
        <button class="link" data-action="stop-challenge">Stop challenge</button>`);
    }

    // Days this month with no discretionary spending.
    function noSpendCard() {
      const m = nowMonth(), today = todayISO();
      const essential = new Set(cats.filter((c) => isEssential(c.name)).map((c) => c.id));
      const spendDays = new Set(txs.filter((t) => t.type !== 'income' && t.date?.startsWith(m) && t.amount > 0 && !essential.has(t.categoryId)).map((t) => t.date));
      const day = Number(today.slice(8, 10));
      const free = Array.from({ length: day }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`).filter((d) => !spendDays.has(d)).length;
      const a = avg();
      const discretionary = cats.filter((c) => c.type === 'expense' && !essential.has(c.id)).reduce((t, c) => t + (a.byCat[c.id] || 0), 0);
      const perDay = round2(discretionary / 30);
      return idea('🚫', 'No-spend days', `<b>${plural(free, 'day')}</b> so far this month with no non-essential spending.${perDay > 0 ? ` Each one is worth about <b>${money(perDay)}</b> at your usual pace. Challenge yourself to hit ${Math.min(day, 10)} by month end.` : ''}
        <div class="bar progress"><span class="fill" style="width:${Math.min(free / Math.max(day, 1), 1) * 100}%"></span></div>`);
    }

    // ---------- modals ----------

    function goalModal(g, starter) {
      const editing = !!g;
      const base = g || { ...starter, target: '', startAmount: '', deadline: '', monthly: '', apr: '' };
      const type = base.type || 'savings';
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit goal' : 'New goal'}</h2>
          <div class="seg" role="radiogroup" aria-label="Type">
            ${Object.entries(TYPES).map(([k, t]) => `<label><input type="radio" name="type" value="${k}" ${type === k ? 'checked' : ''}><span>${t.label.split(' ')[0]}</span></label>`).join('')}
          </div>
          <div class="field-row">
            <label class="field icon-field"><span>Icon</span><input class="input emoji-input" name="icon" maxlength="8" value="${esc(base.icon || TYPES[type].icon)}"></label>
            <label class="field grow"><span>Name</span><input class="input" name="name" maxlength="40" value="${esc(base.name || '')}" ${editing ? '' : 'autofocus'}></label>
          </div>
          <div class="emoji-grid">${EMOJI.map((e) => `<button type="button" class="emoji" data-emoji="${e}">${e}</button>`).join('')}</div>
          <label class="field"><span class="lbl-target">Target amount</span><input class="input" name="target" inputmode="decimal" placeholder="0.00" value="${esc(base.target)}"></label>
          <div class="helpers" data-emergency hidden></div>
          <label class="field"><span class="lbl-start">Already saved</span><input class="input" name="startAmount" inputmode="decimal" placeholder="0.00" value="${esc(base.startAmount)}"></label>
          <label class="field"><span>Deadline <span class="muted">(optional)</span></span><input class="input" type="date" name="deadline" value="${esc(base.deadline || '')}"></label>
          <label class="field" data-apr hidden><span>Interest rate (APR %)</span><input class="input" name="apr" inputmode="decimal" placeholder="e.g. 19.9" value="${esc(base.apr)}"></label>
          <label class="field"><span>Monthly amount you plan to put in <span class="muted">(optional)</span></span><input class="input" name="monthly" inputmode="decimal" placeholder="0.00" value="${esc(base.monthly)}"></label>
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing ? '<button type="button" class="btn danger" data-m="delete">Delete</button>' : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      const a = avg();
      const essentialsMonthly = a.essentials || a.spent;
      const sync = () => {
        const t = form.type.value;
        form.querySelector('.lbl-target').textContent = t === 'debt' ? 'Amount you owe' : 'Target amount';
        form.querySelector('.lbl-start').textContent = t === 'debt' ? 'Already paid off' : 'Already saved';
        form.querySelector('[data-apr]').hidden = t !== 'debt';
        const helpers = form.querySelector('[data-emergency]');
        helpers.hidden = t !== 'emergency' || !(essentialsMonthly > 0);
        helpers.innerHTML = `<span class="muted small">Your essentials run about ${money(essentialsMonthly)}/mo.</span>
          ${[3, 6].map((n) => `<button type="button" class="btn sm" data-months="${n}">${n} months: ${money(essentialsMonthly * n)}</button>`).join('')}`;
      };
      sync();
      form.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', () => {
        const prevDefault = Object.values(TYPES).some((t) => t.icon === form.icon.value);
        sync();
        if (prevDefault) form.icon.value = TYPES[form.type.value].icon;
      }));
      form.querySelector('.emoji-grid').onclick = (e) => { const b = e.target.closest('[data-emoji]'); if (b) form.icon.value = b.dataset.emoji; };
      form.querySelector('[data-emergency]').onclick = (e) => {
        const b = e.target.closest('[data-months]');
        if (b) form.target.value = Math.round(essentialsMonthly * Number(b.dataset.months));
      };
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = () => {
        if (!confirm(`Delete “${g.name}” and its history?`)) return;
        contribs.filter((c) => c.goalId === g.id).forEach((c) => store.remove('contributions', c.id));
        store.remove('goals', g.id);
        closeModal();
        toast('Goal deleted');
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const err = form.querySelector('.form-error');
        const fail = (m, f) => { err.textContent = m; err.hidden = false; f?.focus(); };
        const name = form.name.value.trim();
        const target = parseAmount(form.target.value);
        const num = (f) => (f.value.trim() === '' ? 0 : parseAmount(f.value));
        const startAmount = num(form.startAmount), monthly = num(form.monthly), apr = num(form.apr);
        if (!name) return fail('Give it a name.', form.name);
        if (!(target > 0)) return fail('Enter a target amount above zero.', form.target);
        if (![startAmount, monthly, apr].every((n) => n >= 0)) return fail('Amounts must be zero or more.');
        const data = {
          name, icon: form.icon.value.trim() || TYPES[form.type.value].icon, type: form.type.value, target, startAmount, monthly,
          apr: form.type.value === 'debt' ? apr : 0, deadline: form.deadline.value || '',
        };
        if (editing) store.update('goals', g.id, data);
        else store.add('goals', { ...data, createdDate: todayISO(), archived: false });
        closeModal();
        toast('Saved');
      };
    }

    // Add (or take out) money. `goalId` may be omitted to choose one.
    function moneyModal({ goalId = '', amount = '', note = '' } = {}) {
      const funds = [...active().map((g) => [g.id, `${g.icon || ''} ${g.name}`]), ...(hasWedding() ? [[WEDDING_ID, '💍 Wedding fund']] : [])];
      if (!funds.length) { toast('Create a goal first'); return; }
      const debtGoal = goals.find((g) => g.id === goalId)?.type === 'debt';
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${debtGoal ? 'Log a payment' : 'Add money'}</h2>
          <label class="field"><span>Goal</span><select class="input" name="goalId">${funds.map(([id, n]) => `<option value="${esc(id)}" ${id === goalId ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <div class="seg" role="radiogroup" aria-label="Direction">
            <label><input type="radio" name="dir" value="in" checked><span>${debtGoal ? 'Payment' : 'Add'}</span></label>
            <label><input type="radio" name="dir" value="out"><span>Take out</span></label>
          </div>
          <label class="field"><span>Amount</span><input class="input amount" name="amount" inputmode="decimal" placeholder="0.00" value="${esc(amount)}" autofocus></label>
          <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${todayISO()}"></label>
          <label class="field"><span>Note <span class="muted">(optional)</span></span><input class="input" name="note" maxlength="80" value="${esc(note)}"></label>
          <p class="form-error" hidden></p>
          <div class="form-actions"><span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      form.onsubmit = (e) => {
        e.preventDefault();
        const v = parseAmount(form.amount.value);
        const err = form.querySelector('.form-error');
        if (!(v > 0)) { err.textContent = 'Enter an amount above zero.'; err.hidden = false; return; }
        contribute(form.goalId.value, form.dir.value === 'out' ? -v : v, form.date.value || todayISO(), form.note.value.trim());
        closeModal();
      };
    }

    function contribute(goalId, amount, date, note) {
      const before = goalId === WEDDING_ID ? null : goalStatus(goals.find((g) => g.id === goalId) || {}, contribs);
      store.add('contributions', { goalId, amount, date, note });
      if (!before) { toast('Added to the wedding fund'); return; }
      const g = goals.find((x) => x.id === goalId);
      const after = goalStatus(g, [...contribs, { goalId, amount, date }]);
      const crossed = MILESTONES.filter((m) => after.pct * 100 >= m && before.pct * 100 < m).pop();
      toast(crossed === 100 ? `🎉 ${g.name} ${g.type === 'debt' ? 'paid off' : 'reached'}!` : crossed ? `🎉 ${crossed}% of ${g.name}! ${crossed === 50 ? 'Halfway there.' : 'Keep going.'}` : amount < 0 ? 'Taken out' : 'Added. Nice work!');
    }

    function goalDetail(id) {
      const g = goals.find((x) => x.id === id);
      if (!g) return;
      const st = goalStatus(g, contribs);
      const mine = contribs.filter((c) => c.goalId === id).sort((a, b) => b.date.localeCompare(a.date));
      const debt = g.type === 'debt';
      const dlg = openModal(`
        <div class="form detail">
          <div class="detail-head"><span class="cat-icon">${esc(g.icon || '🎯')}</span><div><h2>${esc(g.name)}</h2><span class="muted small">${TYPES[g.type]?.label}${g.deadline ? ` · by ${fmtDay(g.deadline)}` : ''}</span></div></div>
          <div class="bar progress big" role="progressbar" aria-valuenow="${Math.round(st.pct * 100)}" aria-valuemin="0" aria-valuemax="100"><span class="fill ${st.done ? 'done' : ''}" style="width:${st.pct * 100}%"></span></div>
          <div class="stat-grid">
            <div><span class="muted small">${debt ? 'Paid off' : 'Saved'}</span><b>${money(st.saved)}</b></div>
            <div><span class="muted small">${debt ? 'Still owed' : 'To go'}</span><b>${money(st.remaining)}</b></div>
            <div><span class="muted small">Needed per month</span><b>${st.neededPerMonth == null ? '—' : money(st.neededPerMonth)}</b></div>
            <div><span class="muted small">Your pace</span><b>${st.pace ? `${money(st.pace)}/mo` : '—'}</b></div>
            <div><span class="muted small">On pace to finish</span><b>${st.done ? 'Done 🎉' : st.projected ? fmtMonth(st.projected) : '—'}</b></div>
            <div><span class="muted small">${g.apr ? 'Interest rate' : 'Target'}</span><b>${g.apr ? `${g.apr}%` : money(st.target)}</b></div>
          </div>
          ${pathChart(g, st)}
          ${debt && g.apr && !st.done ? `
            <div class="whatif detail-whatif">
              <label class="field"><span>What if I pay extra each month?</span><div class="money-input"><span>$</span><input class="input" inputmode="decimal" placeholder="e.g. 50" data-extra aria-label="Extra monthly payment"></div></label>
              <div class="extra-result muted small">Enter an amount to see the payoff date and interest saved.</div>
            </div>` : ''}
          <h3 class="detail-sub">History</h3>
          ${mine.length ? `<div class="list">${mine.slice(0, 8).map((c) => `
            <div class="row static"><span class="row-main"><span class="row-title">${c.amount < 0 ? 'Taken out' : debt ? 'Payment' : 'Added'}${c.note ? ` · ${esc(c.note)}` : ''}</span><span class="row-sub">${esc(fmtDay(c.date))}</span></span>
              <span class="row-amt ${c.amount < 0 ? '' : 'pos'}">${c.amount < 0 ? '−' : '+'}${money(Math.abs(c.amount))}</span>
              <button class="link danger" data-del="${esc(c.id)}" aria-label="Delete this entry">✕</button></div>`).join('')}</div>` : '<p class="muted small">Nothing yet. Tap “Add money” to start.</p>'}
          <div class="form-actions">
            <button type="button" class="btn" data-m="edit">Edit goal</button>
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="close">Close</button>
            ${st.done ? '' : `<button type="button" class="btn primary" data-m="add">${debt ? 'Log payment' : 'Add money'}</button>`}
          </div>
        </div>`);
      dlg.querySelector('[data-m=close]').onclick = closeModal;
      dlg.querySelector('[data-m=edit]').onclick = () => { closeModal(); goalModal(g); };
      const addBtn = dlg.querySelector('[data-m=add]');
      if (addBtn) addBtn.onclick = () => { closeModal(); moneyModal({ goalId: id }); };
      dlg.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { store.remove('contributions', b.dataset.del); closeModal(); toast('Removed'); }; });
      const extra = dlg.querySelector('[data-extra]');
      if (extra) extra.oninput = () => {
        const e = parseAmount(extra.value) || 0;
        const base = st.payment || st.neededPerMonth || 0;
        const out = dlg.querySelector('.extra-result');
        if (!(base > 0)) { out.textContent = 'Set a monthly payment on this goal first.'; return; }
        const a0 = amortize(st.remaining, g.apr, base), a1 = amortize(st.remaining, g.apr, base + e);
        if (!Number.isFinite(a1.months)) { out.textContent = 'That payment doesn’t cover the interest yet. Try a bigger amount.'; return; }
        out.innerHTML = e > 0 && Number.isFinite(a0.months)
          ? `Debt-free in <b>${plural(a1.months, 'month')}</b> (${fmtMonth(addMonthsISO(todayISO(), a1.months))})${a1.months < a0.months ? ` instead of ${a0.months}` : ''}, saving <b>${money(a0.interest - a1.interest)}</b> in interest.`
          : `At ${money(base)}/mo: ${Number.isFinite(a0.months) ? `${plural(a0.months, 'month')}, ${money(a0.interest)} interest` : 'payment too small to cover interest'}.`;
      };
    }

    // Saved so far vs. the straight line needed to hit the deadline, plus where the current pace leads.
    function pathChart(g, st) {
      const mine = contribs.filter((c) => c.goalId === g.id);
      const startDate = [g.createdDate, ...mine.map((c) => c.date)].filter(Boolean).sort()[0] || todayISO();
      const first = startDate.slice(0, 7), now = nowMonth();
      const endTarget = g.deadline ? g.deadline.slice(0, 7) : st.projected ? st.projected.slice(0, 7) : addMonths(now, 6);
      let end = endTarget > now ? endTarget : addMonths(now, 1);
      let from = first;
      if (monthsDiff(from, end) > 36) from = addMonths(end, -36);
      const months = [];
      for (let m = from; m <= end; m = addMonths(m, 1)) months.push(m);
      if (months.length < 2) return '';
      const start = Number(g.startAmount) || 0;
      const savedAt = (m) => round2(start + sumBy(mine.filter((c) => c.date.slice(0, 7) <= m)));
      const idxNow = months.indexOf(now);
      const req = g.deadline ? months.map((m, i) => round2(start + (st.target - start) * (i / (months.length - 1)))) : null;
      const act = months.map((m) => (m <= now ? savedAt(m) : null));
      const proj = st.payment > 0 && idxNow >= 0 ? months.map((m, i) => (i < idxNow ? null : Math.min(st.target, round2(st.saved + st.payment * (i - idxNow))))) : null;
      const labels = months.map((m) => monthLabel(m, months.length > 12 ? { month: 'short', year: '2-digit' } : { month: 'short' }));
      const series = [
        ...(req ? [{ name: 'Needed to hit deadline', cls: 'req', values: req }] : []),
        { name: g.type === 'debt' ? 'Paid off' : 'Saved', cls: 'act', values: act },
        ...(proj ? [{ name: 'At your pace', cls: 'proj', values: proj }] : []),
      ];
      return `<div class="path-chart">${lineChart({ labels, series, aria: `${g.name} progress over time` })}</div>`;
    }
    const monthsDiff = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

    // ---------- events ----------

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const id = b.dataset.id;
      switch (b.dataset.action) {
        case 'new-goal': return goalModal(null, b.dataset.starter !== undefined ? STARTERS[Number(b.dataset.starter)] : { type: 'savings', name: '', icon: '🎯' });
        case 'open-goal': return goalDetail(id);
        case 'add-money': return moneyModal({ goalId: id });
        case 'quick-add': return moneyModal({ amount: b.dataset.amount, note: b.dataset.note });
        case 'apply-trim':
          store.update('categories', id, { budget: Number(b.dataset.val) });
          toast('Budget lowered. Check it under Budget → Plan.');
          return;
        case 'apply-windfall': {
          const s = windfallSplit(active().filter((g) => !goalStatus(g, contribs).done));
          if (!s?.parts.length) return;
          s.parts.forEach((p) => store.add('contributions', { goalId: p.id, amount: p.share, date: todayISO(), note: 'Windfall' }));
          ui.windfall = '';
          toast(`🎉 ${money(s.amount)} put to work`);
          return;
        }
        case 'start-challenge': {
          const goalId = root.querySelector('[data-input=ch-goal]')?.value;
          if (!goalId) { toast('Create a goal first'); return; }
          saveSetting('challenge', { startDate: todayISO(), goalId, mult: Number(root.querySelector('[data-input=ch-mult]').value) || 1, done: [] });
          toast('Challenge started. Week 1 is just $1.');
          return;
        }
        case 'log-week': {
          const ch = settings.challenge, week = Number(b.dataset.week);
          contribute(ch.goalId, week * ch.mult, todayISO(), `52-week challenge, week ${week}`);
          saveSetting('challenge', { done: [...new Set([...(ch.done || []), week])] });
          return;
        }
        case 'stop-challenge':
          if (confirm('Stop the 52-week challenge? Your saved money stays in the goal.')) saveSetting('challenge', { startDate: '', done: [] });
          return;
        default:
      }
    });

    // Live updates for the calculators without redrawing (keeps sliders and typing smooth).
    root.addEventListener('input', (e) => {
      const k = e.target.dataset.input;
      if (k === 'whatif-pct') {
        ui.whatifPct = Number(e.target.value);
        root.querySelector('.whatif-pct').textContent = `${ui.whatifPct}%`;
        const list = active(), stats = new Map(list.map((g) => [g.id, goalStatus(g, contribs)]));
        root.querySelector('.whatif-result').innerHTML = whatifResult(avg(), list.find((g) => !stats.get(g.id).done), stats);
      } else if (k === 'whatif-cat') {
        ui.whatifCat = e.target.value;
        const list = active(), stats = new Map(list.map((g) => [g.id, goalStatus(g, contribs)]));
        root.querySelector('.whatif-result').innerHTML = whatifResult(avg(), list.find((g) => !stats.get(g.id).done), stats);
      } else if (k === 'windfall') {
        ui.windfall = e.target.value;
        root.querySelector('.windfall-result').innerHTML = windfallPreview(active().filter((g) => !goalStatus(g, contribs).done));
      } else if (k === 'windfall-fun') {
        ui.windfallFun = e.target.checked;
        root.querySelector('.windfall-result').innerHTML = windfallPreview(active().filter((g) => !goalStatus(g, contribs).done));
      }
    });

    const unsubs = [
      store.subscribe('goals', (l) => { goals = l; draw(); }),
      store.subscribe('contributions', (l) => { contribs = l; draw(); }),
      store.subscribe('categories', (l) => { cats = l; draw(); }),
      store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); draw(); }),
      store.subscribe('weddingItems', (l) => { wItems = l; draw(); }),
      // 7 months is enough for averages, round-ups and recurring-charge detection.
      store.subscribeWhere('transactions', [['date', '>=', `${addMonths(nowMonth(), -6)}-01`]], (l) => { txs = l; draw(); }),
    ];

    draw();
    return () => unsubs.forEach((u) => u());
  },
};

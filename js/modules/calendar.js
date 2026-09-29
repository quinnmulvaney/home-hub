import * as store from '../store.js';
import {
  esc, money, parseAmount, todayISO, monthKey, addMonths, monthLabel, openModal, closeModal, toast, toastUndo, confirmDialog, renderKeepingFocus, dayLabel,
} from '../util.js';
import { billOccurrences, billStatus, upcomingBills, addDaysISO, daysBetweenISO, round2 } from '../stats.js';
import { merchantKey } from '../merchant.js';
import { subscribeRecent } from '../alerts.js';
import { countdownHtml, startCountdown } from '../countdown.js';

// bills:         { name, amount, freq, day, startDate, autopay, remindDays, categoryId, match, paid: {due: true}, active }
// subscriptions: written by the bank-sync job: { key, name, frequency, amount, previous, changedOn, lastDate, nextDate, runs, monthly, active, ignored }
store.registerCollections(['bills', 'subscriptions', 'categories', 'settings']);

const FREQ = { monthly: 'Monthly', biweekly: 'Every 2 weeks', weekly: 'Weekly', yearly: 'Yearly' };
const STATUS_TEXT = { paid: 'Paid', auto: 'Autopay', late: 'Overdue', soon: 'Due soon', due: 'Upcoming' };
const shortDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const ui = { tab: 'calendar', month: monthKey(new Date()), selected: '' };

export default {
  id: 'calendar',
  title: 'Calendar',
  icon: '📅',
  render(el) {
    const root = document.createElement('div');
    root.className = 'calendar';
    el.appendChild(root);

    let bills = [], subs = [], cats = [], txs = [], settings = {};
    let stopCountdown = () => {};

    const activeBills = () => bills.filter((b) => b.active !== false);
    const isTracked = (s) => activeBills().some((b) => { const k = merchantKey(b.match || b.name); return k && (s.key.startsWith(k) || k.startsWith(s.key)); });

    // ---------- drawing ----------

    function draw() {
      stopCountdown();
      const wedding = settings.wedding?.date;
      renderKeepingFocus(root, `
        ${wedding ? `<section class="card hero hero-compact"><div class="hero-eyebrow">💍 Our wedding</div>${countdownHtml(wedding)}</section>` : ''}
        <div class="tabs cal-tabs" role="tablist">
          ${[['calendar', 'Calendar'], ['bills', 'Bills'], ['subs', 'Subscriptions']].map(([id, label]) =>
            `<button role="tab" class="tab ${ui.tab === id ? 'active' : ''}" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${label}${id === 'subs' && changed().length ? ` <span class="badge warn">${changed().length}</span>` : ''}</button>`).join('')}
        </div>
        ${ui.tab === 'calendar' ? calendarTab() : ui.tab === 'bills' ? billsTab() : subsTab()}`);
      stopCountdown = startCountdown(root);
    }

    // ---------- calendar ----------

    function calendarTab() {
      const [y, m] = ui.month.split('-').map(Number);
      const days = new Date(y, m, 0).getDate();
      const startDow = new Date(y, m - 1, 1).getDay();
      const today = todayISO();
      const byDay = {};
      for (const b of activeBills()) {
        for (const due of billOccurrences(b, `${ui.month}-01`, `${ui.month}-${String(days).padStart(2, '0')}`)) {
          (byDay[due] ||= []).push({ bill: b, due, status: billStatus(b, due, txs, today) });
        }
      }
      const wedDate = settings.wedding?.date;
      const cells = [];
      for (let i = 0; i < startDow; i++) cells.push('<span class="cal-day blank" aria-hidden="true"></span>');
      for (let d = 1; d <= days; d++) {
        const date = `${ui.month}-${String(d).padStart(2, '0')}`;
        const items = byDay[date] || [];
        const dotClass = (st) => (st === 'paid' ? 'paid' : st === 'late' ? 'late' : st === 'auto' ? 'auto' : 'due');
        cells.push(`
          <button class="cal-day ${date === today ? 'today' : ''} ${date === ui.selected ? 'selected' : ''}" data-action="pick-day" data-date="${date}"
            aria-label="${esc(longDay(date))}${items.length ? `, ${plural(items.length, 'bill')}` : ''}">
            <span>${d}${wedDate === date ? ' 💍' : ''}</span>
            <span class="cal-dots compact">${items.slice(0, 4).map((i) => `<i class="dot ${dotClass(i.status)}"></i>`).join('')}</span>
            ${items.slice(0, 2).map((i) => `<span class="cal-pill ${dotClass(i.status)}">${esc(i.bill.name)}</span>`).join('')}
            ${items.length > 2 ? `<span class="cal-pill">+${items.length - 2} more</span>` : ''}
          </button>`);
      }
      const sel = ui.selected && ui.selected.startsWith(ui.month) ? ui.selected : '';
      const selItems = sel ? byDay[sel] || [] : [];
      return `
        <section class="card">
          <div class="cal-head">
            <button class="icon-btn" data-action="prev-month" aria-label="Previous month">‹</button>
            <h2>${esc(monthLabel(ui.month))}</h2>
            <button class="icon-btn" data-action="next-month" aria-label="Next month">›</button>
          </div>
          <div class="cal-grid" role="grid">
            ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}
            ${cells.join('')}
          </div>
          <div class="cal-legend">
            <span><i class="dot auto"></i>Autopay</span><span><i class="dot due"></i>Due</span><span><i class="dot paid"></i>Paid</span><span><i class="dot late"></i>Overdue</span>
            <button class="link" data-action="today">Today</button>
          </div>
          ${sel ? `<div class="day-detail"><h3>${esc(longDay(sel))}</h3>
            ${selItems.length ? selItems.map((i) => billRow(i.bill, i.due, i.status)).join('') : '<p class="muted small">Nothing due.</p>'}</div>` : ''}
        </section>
        ${activeBills().length ? '' : '<p class="muted small">Add your recurring bills in the <b>Bills</b> tab and they show up here.</p>'}`;
    }

    function billRow(b, due, status) {
      return `
        <div class="bill">
          <button class="bill-main" data-action="edit-bill" data-id="${esc(b.id)}">
            <span class="bill-name">${esc(b.name)}</span>
            <span class="small muted">${esc(shortDay(due))} · ${esc(FREQ[b.freq] || 'Monthly')}${b.autopay ? '' : ` · reminder ${plural(Number(b.remindDays) || 3, 'day')} before`}</span>
          </button>
          <span class="st ${status}">${STATUS_TEXT[status]}</span>
          <span class="bill-amt">${money(b.amount)}</span>
          ${!b.autopay && status !== 'paid' ? `<button class="btn sm" data-action="mark-paid" data-id="${esc(b.id)}" data-due="${due}">Mark paid</button>` : ''}
        </div>`;
    }

    // ---------- bills ----------

    function billsTab() {
      const today = todayISO();
      // Just the next occurrence of each bill.
      const seenBills = new Set();
      const coming = upcomingBills(activeBills(), txs, today, 45, 7).filter((i) => (seenBills.has(i.bill.id) ? false : seenBills.add(i.bill.id)));
      const suggestions = subs.filter((s) => s.active !== false && !s.ignored && s.frequency !== 'quarterly' && !isTracked(s)).slice(0, 5);
      const monthly = round2(activeBills().reduce((t, b) => t + (b.freq === 'yearly' ? b.amount / 12 : b.freq === 'weekly' ? b.amount * 52 / 12 : b.freq === 'biweekly' ? b.amount * 26 / 12 : b.amount), 0));
      return `
        <section class="card">
          <div class="card-head"><h2>Recurring bills</h2><button class="btn primary sm" data-action="add-bill">+ Add bill</button></div>
          ${activeBills().length ? `<p class="muted small">${plural(activeBills().length, 'bill')} · about ${money(monthly)} a month. Bills on autopay skip reminders.</p>` : '<p class="muted">No bills yet. Add rent, electric, internet, insurance... and get a reminder before each one is due (skipped for autopay).</p>'}
          ${coming.length ? `<div class="upcoming">${coming.map((i) => billRow(i.bill, i.due, i.status)).join('')}</div>` : ''}
        </section>
        ${suggestions.length ? `
        <section class="card">
          <div class="card-head"><h2>Found in your spending</h2></div>
          <p class="muted small">These repeat every month or year. Add them to get them on the calendar.</p>
          ${suggestions.map((s) => `
            <div class="bill">
              <span class="bill-main"><span class="bill-name">${esc(s.name)}</span><span class="small muted">${esc(s.frequency)} · last ${esc(shortDay(s.lastDate))}</span></span>
              <span class="bill-amt">${money(s.amount)}</span>
              <button class="btn sm" data-action="add-from-sub" data-id="${esc(s.id)}">Add</button>
            </div>`).join('')}
        </section>` : ''}
        ${activeBills().length > coming.length ? `
        <section class="card">
          <div class="card-head"><h2>All bills</h2></div>
          ${[...activeBills()].sort((a, b) => a.name.localeCompare(b.name)).map((b) => `
            <div class="bill">
              <button class="bill-main" data-action="edit-bill" data-id="${esc(b.id)}"><span class="bill-name">${esc(b.name)}</span>
                <span class="small muted">${esc(FREQ[b.freq] || 'Monthly')}${b.freq === 'monthly' ? `, day ${b.day || Number((b.startDate || '').slice(8, 10)) || 1}` : ''}</span></button>
              <span class="st ${b.autopay ? 'auto' : 'due'}">${b.autopay ? 'Autopay' : 'Manual'}</span>
              <span class="bill-amt">${money(b.amount)}</span>
            </div>`).join('')}
        </section>` : ''}`;
    }

    function billModal(bill, prefill = {}) {
      const editing = !!bill;
      const b = bill || { name: '', amount: '', freq: 'monthly', day: '', startDate: '', autopay: false, remindDays: 3, categoryId: '', match: '', ...prefill };
      const expense = cats.filter((c) => c.type === 'expense' && !c.archived);
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit bill' : 'Add a bill'}</h2>
          <label class="field"><span>Name</span><input class="input" name="name" maxlength="40" value="${esc(b.name)}" placeholder="e.g. Electric" ${editing ? '' : 'autofocus'}></label>
          <label class="field"><span>Amount</span><input class="input amount" name="amount" inputmode="decimal" placeholder="0.00" value="${esc(b.amount)}"></label>
          <label class="field"><span>How often</span>
            <select class="input" name="freq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${b.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field" data-monthly><span>Day of the month</span><input class="input" name="day" inputmode="numeric" placeholder="1 to 31" value="${esc(b.day || (b.startDate ? Number(b.startDate.slice(8, 10)) : ''))}"></label>
          <label class="field" data-dated hidden><span data-datedlabel>Next due date</span><input class="input" type="date" name="startDate" value="${esc(b.startDate || '')}"></label>
          <label class="check"><input type="checkbox" name="autopay" ${b.autopay ? 'checked' : ''}><span><b>Paid automatically (autopay)</b><br><span class="muted small">No reminder needed.</span></span></label>
          <label class="field" data-remind><span>Remind me</span>
            <select class="input" name="remindDays">${[1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${Number(b.remindDays || 3) === n ? 'selected' : ''}>${plural(n, 'day')} before</option>`).join('')}</select></label>
          <label class="field"><span>Category <span class="muted">(optional)</span></span>
            <select class="input" name="categoryId"><option value="">None</option>${expense.map((c) => `<option value="${esc(c.id)}" ${c.id === b.categoryId ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Shows up on my statement as <span class="muted">(optional)</span></span>
            <input class="input" name="match" maxlength="40" value="${esc(b.match || '')}" placeholder="Helps me notice when it's been paid"></label>
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing ? '<button type="button" class="btn danger" data-m="delete">Delete</button>' : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      const sync = () => {
        const f = form.freq.value;
        form.querySelector('[data-monthly]').hidden = f !== 'monthly';
        form.querySelector('[data-dated]').hidden = f === 'monthly';
        form.querySelector('[data-datedlabel]').textContent = f === 'yearly' ? 'Due date (month and day repeat every year)' : 'Next due date';
        form.querySelector('[data-remind]').hidden = form.autopay.checked;
      };
      sync();
      form.freq.onchange = sync;
      form.autopay.onchange = sync;
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = async () => {
        if (!(await confirmDialog({ title: `Delete “${bill.name}”?`, body: 'Its reminders and calendar entries go away.' }))) { billModal(bill); return; }
        const copy = { ...bill };
        store.remove('bills', bill.id);
        toastUndo(`${copy.name} deleted`, () => store.put('bills', copy.id, copy));
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const err = form.querySelector('.form-error');
        const fail = (m, f) => { err.textContent = m; err.hidden = false; f?.focus(); };
        const amount = parseAmount(form.amount.value);
        const freq = form.freq.value;
        const day = parseInt(form.day.value, 10);
        if (!form.name.value.trim()) return fail('Give it a name.', form.name);
        if (!(amount > 0)) return fail('Enter the amount.', form.amount);
        if (freq === 'monthly' && !(day >= 1 && day <= 31)) return fail('Enter a day from 1 to 31.', form.day);
        if (freq !== 'monthly' && !form.startDate.value) return fail('Pick a due date.', form.startDate);
        const data = {
          name: form.name.value.trim(), amount, freq, autopay: form.autopay.checked, remindDays: Number(form.remindDays.value) || 3,
          day: freq === 'monthly' ? day : 0, startDate: freq === 'monthly' ? '' : form.startDate.value,
          categoryId: form.categoryId.value, match: merchantKey(form.match.value || form.name.value), active: true,
          paid: bill?.paid || {},
        };
        if (editing) store.update('bills', bill.id, data);
        else store.add('bills', data);
        closeModal();
        toast('Saved');
      };
    }

    // ---------- subscriptions ----------

    const changed = () => subs.filter((s) => s.active !== false && !s.ignored && s.previous != null && s.changedOn && daysBetweenISO(s.changedOn, todayISO()) <= 90);

    function subsTab() {
      const live = subs.filter((s) => s.active !== false && !s.ignored).sort((a, b) => (b.monthly || 0) - (a.monthly || 0));
      const hidden = subs.filter((s) => s.active !== false && s.ignored);
      const monthly = round2(live.reduce((t, s) => t + (s.monthly || 0), 0));
      if (!subs.length) {
        return `<section class="card"><h2>Subscription tracker</h2>
          <p class="muted">Recurring payments (streaming, insurance, memberships...) are found automatically from your bank history each time the bank sync runs, three times a day. Home Hub watches each one and tells you the moment a price changes.</p>
          <p class="muted small">Nothing has been detected yet. This fills in after the next sync.</p></section>`;
      }
      const card = (s) => {
        const delta = s.previous != null ? round2(s.amount - s.previous) : 0;
        const recent = s.changedOn && s.previous != null && daysBetweenISO(s.changedOn, todayISO()) <= 90;
        const trail = (s.runs || []).length > 1 ? (s.runs || []).slice(-4).map((r) => `${money(r.amount)} <span class="muted">(${esc(shortDay(r.since))})</span>`).join(' → ') : '';
        return `
          <div class="sub-card">
            <div class="sub-top">
              <span class="cat-icon" aria-hidden="true">${s.previous != null && delta > 0 ? '📈' : '🔁'}</span>
              <span><span class="sub-name">${esc(s.name)}</span><br><span class="small muted">${esc(s.frequency)} · last charged ${esc(shortDay(s.lastDate))}${s.nextDate ? ` · next about ${esc(shortDay(s.nextDate))}` : ''}</span></span>
              <span class="sub-price">${money(s.amount)}<br><span class="small muted">${s.frequency === 'yearly' ? `${money(s.monthly)}/mo` : s.frequency === 'quarterly' ? `${money(s.monthly)}/mo` : `${money(s.amount * 12)}/yr`}</span></span>
            </div>
            ${recent && Math.abs(delta) >= 0.01 ? `<div><span class="chg ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲ Price went up' : '▼ Price went down'} ${money(Math.abs(delta))} (${Math.round(Math.abs(delta) / s.previous * 100)}%) on ${esc(shortDay(s.changedOn))}</span></div>` : ''}
            ${trail ? `<div class="price-trail">Price history: ${trail}</div>` : ''}
            <div class="sub-actions">
              ${s.frequency !== 'quarterly' && !isTracked(s) ? `<button class="btn sm" data-action="add-from-sub" data-id="${esc(s.id)}">Add to bills</button>` : ''}
              <button class="link" data-action="ignore-sub" data-id="${esc(s.id)}">Not a subscription</button>
            </div>
          </div>`;
      };
      return `
        <div class="sub-summary">
          <div><span class="muted small">Tracked</span><b>${live.length}</b></div>
          <div><span class="muted small">Per month</span><b>${money(monthly)}</b></div>
          <div><span class="muted small">Per year</span><b>${money(monthly * 12)}</b></div>
        </div>
        ${changed().length ? `<section class="card"><div class="card-head"><h2>Price changes</h2></div>${changed().map(card).join('')}</section>` : ''}
        <section class="card">
          <div class="card-head"><h2>All subscriptions</h2></div>
          ${live.filter((s) => !changed().includes(s)).map(card).join('') || '<p class="muted small">Everything tracked has a recent price change (above).</p>'}
        </section>
        ${hidden.length ? `<details class="card"><summary>Hidden (${hidden.length})</summary>${hidden.map((s) => `
          <div class="bill"><span class="bill-main"><span class="bill-name">${esc(s.name)}</span></span><span class="bill-amt">${money(s.amount)}</span>
            <button class="btn sm" data-action="restore-sub" data-id="${esc(s.id)}">Restore</button></div>`).join('')}</details>` : ''}`;
    }

    // ---------- events ----------

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const id = b.dataset.id;
      switch (b.dataset.action) {
        case 'tab': ui.tab = b.dataset.tab; break;
        case 'prev-month': ui.month = addMonths(ui.month, -1); break;
        case 'next-month': ui.month = addMonths(ui.month, 1); break;
        case 'today': ui.month = monthKey(new Date()); ui.selected = todayISO(); break;
        case 'pick-day': ui.selected = ui.selected === b.dataset.date ? '' : b.dataset.date; break;
        case 'add-bill': return billModal(null);
        case 'edit-bill': return billModal(bills.find((x) => x.id === id));
        case 'add-from-sub': {
          const s = subs.find((x) => x.id === id);
          if (!s) return;
          const yearly = s.frequency === 'yearly';
          return billModal(null, {
            name: s.name, amount: s.amount, freq: yearly ? 'yearly' : 'monthly', day: Number((s.lastDate || '').slice(8, 10)) || '',
            startDate: yearly ? s.lastDate : '', match: s.key, autopay: false,
          });
        }
        case 'mark-paid': {
          const bill = bills.find((x) => x.id === id);
          if (!bill) return;
          const due = b.dataset.due;
          const paid = Object.fromEntries(Object.entries({ ...(bill.paid || {}), [due]: true }).sort().slice(-24));
          store.update('bills', id, { paid });
          toastUndo(`${bill.name} marked paid`, () => store.update('bills', id, { paid: bill.paid || {} }));
          return;
        }
        case 'ignore-sub': {
          store.update('subscriptions', id, { ignored: true });
          toastUndo('Hidden from the tracker', () => store.update('subscriptions', id, { ignored: false }));
          return;
        }
        case 'restore-sub': store.update('subscriptions', id, { ignored: false }); return;
        default: return;
      }
      draw();
    });

    const unsubs = [
      store.subscribe('bills', (l) => { bills = l; draw(); }),
      store.subscribe('subscriptions', (l) => { subs = l; draw(); }),
      store.subscribe('categories', (l) => { cats = l; }),
      store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); draw(); }),
      subscribeRecent((l) => { txs = l; draw(); }),
    ];

    draw();
    return () => { stopCountdown(); unsubs.forEach((u) => u()); };
  },
};

import * as store from '../store.js';
import {
  esc, money, parseAmount, todayISO, monthKey, addMonths, monthLabel, openModal, closeModal, toast, renderKeepingFocus,
} from '../util.js';
import { weddingSummary, round2, sumBy, WEDDING_ID } from '../stats.js';
import { lineChart, ring } from '../charts.js';
import { sortable } from '../sortable.js';

// settings/wedding:  { date, guests, budget }
// weddingItems:      { name, icon, estimate, paid, vendor, dueDate, note, order }
// contributions:     { goalId: 'wedding', amount (negative = paid out of the fund), date, note }
store.registerCollections(['settings', 'weddingItems', 'contributions']);

// Typical split of a wedding budget, as a starting point to edit.
const TEMPLATE = [
  ['Venue', '🏛️', 20], ['Catering & bar', '🍽️', 25], ['Photography & video', '📸', 10], ['Attire & alterations', '👗', 8],
  ['Flowers & decor', '💐', 8], ['Music / DJ', '🎶', 7], ['Rings', '💍', 3], ['Cake & desserts', '🎂', 2],
  ['Invitations & stationery', '💌', 2], ['Hair & makeup', '💄', 2], ['Officiant & license', '📜', 1],
  ['Transportation', '🚗', 2], ['Favors & gifts', '🎁', 1], ['Honeymoon', '🏝️', 5], ['Contingency (unexpected)', '🧾', 4],
];
const EMOJI = ['💍', '🏛️', '🍽️', '📸', '👗', '🤵', '💐', '🎶', '🎂', '💌', '💄', '📜', '🚗', '🎁', '🏝️', '🧾', '🍾', '🪑', '🏨', '✨'];
const fmtDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export default {
  id: 'wedding',
  title: 'Wedding',
  icon: '💍',
  render(el) {
    const root = document.createElement('div');
    root.className = 'wedding';
    el.appendChild(root);

    let settings = {}, items = [], contribs = [];
    let holdDraw = false, dirty = false, dragging = false;
    const plan = () => settings.wedding || {};
    const savePlan = (patch) => store.put('settings', 'wedding', { ...plan(), ...patch });
    function hold() { holdDraw = true; setTimeout(() => { holdDraw = false; if (dirty) { dirty = false; draw(); } }, 400); }


    function draw() {
      if (holdDraw || dragging) { dirty = true; return; }
      const w = weddingSummary(plan(), items, contribs);
      renderKeepingFocus(root, `
        ${headerCard(w)}
        ${items.length ? `${splitCard()}${itemsCard()}${pathCard(w)}` : emptyCard()}
        <button class="fab" data-action="add-item" aria-label="Add a wedding expense" title="Add a wedding expense">+</button>`);
    }

    function headerCard(w) {
      const p = plan();
      const fundedPct = w.total > 0 ? Math.min(Math.max(1 - w.remaining / w.total, 0), 1) : 0;
      const weeks = w.neededPerMonth ? round2((w.neededPerMonth * 12) / 52) : 0;
      const budget = Number(p.budget) || 0;
      const guests = Number(p.guests) || 0;
      const daysLeft = p.date ? Math.ceil((new Date(`${p.date}T12:00`) - Date.now()) / 864e5) : null;
      return `
        <section class="card wed-head">
          <div class="wed-grid">
            <label class="field"><span>Wedding date</span><input class="input" type="date" data-field="date" data-focus-key="wdate" value="${esc(p.date || '')}"></label>
            <label class="field"><span>Guests</span><input class="input" inputmode="numeric" data-field="guests" data-focus-key="wguests" value="${guests || ''}" placeholder="0"></label>
            <label class="field"><span>Total budget</span><div class="money-input"><span>$</span><input class="input" inputmode="decimal" data-field="budget" data-focus-key="wbudget" value="${budget || ''}" placeholder="0"></div></label>
          </div>
          ${daysLeft !== null ? `<p class="wed-count">${daysLeft > 0 ? `<b>${daysLeft}</b> days to go` : daysLeft === 0 ? '<b>Today is the day! 💍</b>' : 'Congratulations! 🎉'}</p>` : ''}
          ${items.length ? `
          <div class="summary-top">
            ${ring(fundedPct, `${Math.round(fundedPct * 100)}%`, 'funded')}
            <div class="wed-numbers">
              <div><span class="muted small">Total cost</span><b>${money(w.total)}</b></div>
              <div><span class="muted small">Paid so far</span><b>${money(w.paid)}</b></div>
              <div><span class="muted small">Wedding fund</span><b>${money(w.balance)}</b></div>
              <div><span class="muted small">Still to save</span><b>${money(w.remaining)}</b></div>
            </div>
          </div>
          ${w.done ? '<p class="good">🎉 Fully funded. Everything left to pay is covered.</p>'
            : p.date ? `<div class="need-box"><b>Save ${money(w.neededPerMonth || 0)}/month</b> <span class="muted">(about ${money(weeks)}/week) for ${plural(w.monthsLeft || 1, 'month')}</span>
              <div class="small ${w.onTrack ? 'good' : 'muted'}">${w.onTrack ? '✓ On track at your current pace' : w.projected ? `At your current pace you'd finish saving in ${fmtMonth(w.projected)}, after the wedding.` : 'Add money to the fund to see your pace.'}</div></div>`
            : '<p class="muted small">Set your wedding date to see how much to save each month.</p>'}
          <div class="chips">
            ${budget ? `<span class="chip ${w.total > budget ? 'bad' : 'on'}">${w.total > budget ? `Over budget by ${money(w.total - budget)}` : w.total === budget ? 'Right on budget' : `${money(budget - w.total)} under budget`}</span>` : ''}
            ${guests ? `<span class="chip">${money(w.total / guests)} per guest</span>` : ''}
          </div>
          <div class="btn-row"><button class="btn primary" data-action="add-fund">Add to wedding fund</button></div>` : ''}
        </section>`;
    }

    function emptyCard() {
      const p = plan();
      return `
        <section class="card intro">
          <h2>Plan every piece, then break it into monthly savings</h2>
          <p class="muted">Enter your total budget and guest count and Home Hub will split it across the usual wedding costs. You can edit every line. Then it works out exactly what to save each month.</p>
          <button class="btn primary" data-action="template">Start from a budget</button>
          <button class="btn" data-action="add-item">Add costs myself</button>
          ${p.budget ? '' : ''}
        </section>`;
    }

    // Stacked bar: each cost's share of the total, largest first.
    function splitCard() {
      const rows = items.map((i) => ({ name: i.name, v: Math.max(Number(i.estimate) || 0, Number(i.paid) || 0) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
      const total = sumBy(rows, (r) => r.v);
      if (!total) return '';
      const top = rows.slice(0, 7);
      const rest = round2(total - sumBy(top, (r) => r.v));
      const segs = [...top, ...(rest > 0 ? [{ name: `${rows.length - 7} more`, v: rest, other: true }] : [])];
      return `
        <section class="card">
          <div class="card-head"><h2>Where the money goes</h2><span class="muted small">${money(total)}</span></div>
          <div class="stack" role="img" aria-label="Share of the wedding budget by cost">${segs.map((s, i) => `<span class="stack-seg ${s.other ? 'other' : `c${i + 1}`}" style="flex:${s.v}" title="${esc(s.name)} ${money(s.v)}"></span>`).join('')}</div>
          <ul class="stack-legend">${segs.map((s, i) => `<li><i class="sw ${s.other ? 'other' : `c${i + 1}`}"></i><span>${esc(s.name)}</span><b>${money(s.v)}</b><span class="muted small">${Math.round(s.v / total * 100)}%</span></li>`).join('')}</ul>
        </section>`;
    }

    function itemsCard() {
      return `
        <section class="card">
          <div class="card-head"><h2>Costs</h2><button class="link" data-action="template">Re-split a budget</button></div>
          <div class="items">${items.map(itemRow).join('')}</div>
        </section>`;
    }

    function itemRow(i) {
      const est = Number(i.estimate) || 0, paid = Number(i.paid) || 0;
      const cost = Math.max(est, paid);
      const pct = cost > 0 ? Math.min(paid / cost, 1) * 100 : 0;
      const overdue = i.dueDate && paid < cost && i.dueDate < todayISO();
      return `
        <div class="item" data-id="${esc(i.id)}">
          <button class="drag-handle" data-focus-key="drag-${esc(i.id)}" aria-label="Reorder ${esc(i.name)}. Drag, or use the up and down arrow keys." title="Drag to reorder">⋮⋮</button>
          <button class="item-main" data-action="edit-item" data-id="${esc(i.id)}">
            <span class="cat-icon" aria-hidden="true">${esc(i.icon || '✨')}</span>
            <span class="item-body">
              <span class="budget-top"><span class="name">${esc(i.name)}</span><span class="amt">${money(paid)} <span class="muted">of ${money(cost)}</span></span></span>
              <span class="bar progress"><span class="fill ${paid >= cost && cost > 0 ? 'done' : ''}" style="width:${pct}%"></span></span>
              <span class="budget-sub ${overdue ? 'bad' : ''}">${[i.vendor, i.dueDate ? `${overdue ? 'was due' : 'due'} ${fmtDay(i.dueDate)}` : ''].filter(Boolean).map(esc).join(' · ') || (paid >= cost && cost > 0 ? 'Paid in full ✓' : 'Estimate')}</span>
            </span>
          </button>
          ${paid < cost ? `<button class="btn sm" data-action="pay-item" data-id="${esc(i.id)}">Pay</button>` : ''}
        </div>`;
    }

    // Cumulative saved into the fund vs. the straight line needed to reach the total by the wedding.
    function pathCard(w) {
      const p = plan();
      if (!p.date || !(w.total > 0)) return '';
      const mine = contribs.filter((c) => c.goalId === WEDDING_ID && c.amount > 0);
      const first = [todayISO(), ...mine.map((c) => c.date)].sort()[0].slice(0, 7);
      const now = monthKey(new Date());
      const end = p.date.slice(0, 7) > now ? p.date.slice(0, 7) : addMonths(now, 1);
      let from = first;
      const span = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
      if (span(from, end) > 36) from = addMonths(end, -36);
      const months = [];
      for (let m = from; m <= end; m = addMonths(m, 1)) months.push(m);
      if (months.length < 2) return '';
      const savedAt = (m) => round2(sumBy(mine.filter((c) => c.date.slice(0, 7) <= m)));
      const idxNow = months.indexOf(now);
      const totalSaved = savedAt(now);
      const pace = w.pace;
      const series = [
        { name: 'Needed by the wedding', cls: 'req', values: months.map((m, i) => round2((w.total * i) / (months.length - 1))) },
        { name: 'Saved so far', cls: 'act', values: months.map((m) => (m <= now ? savedAt(m) : null)) },
        ...(pace > 0 && idxNow >= 0 ? [{ name: 'At your pace', cls: 'proj', values: months.map((m, i) => (i < idxNow ? null : Math.min(w.total, round2(totalSaved + pace * (i - idxNow))))) }] : []),
      ];
      const labels = months.map((m) => monthLabel(m, months.length > 12 ? { month: 'short', year: '2-digit' } : { month: 'short' }));
      return `
        <section class="card">
          <div class="card-head"><h2>Saving path</h2></div>
          ${lineChart({ labels, series, aria: 'Wedding savings compared with what is needed' })}
        </section>`;
    }

    // ---------- modals ----------

    function itemModal(item) {
      const editing = !!item;
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit cost' : 'Add a wedding cost'}</h2>
          <div class="field-row">
            <label class="field icon-field"><span>Icon</span><input class="input emoji-input" name="icon" maxlength="8" value="${esc(item?.icon || '✨')}"></label>
            <label class="field grow"><span>What is it?</span><input class="input" name="name" maxlength="40" value="${esc(item?.name || '')}" placeholder="e.g. Photographer" ${editing ? '' : 'autofocus'}></label>
          </div>
          <div class="emoji-grid">${EMOJI.map((e) => `<button type="button" class="emoji" data-emoji="${e}">${e}</button>`).join('')}</div>
          <label class="field"><span>Estimated cost</span><input class="input" name="estimate" inputmode="decimal" placeholder="0.00" value="${item?.estimate || ''}"></label>
          <label class="field"><span>Paid so far</span><input class="input" name="paid" inputmode="decimal" placeholder="0.00" value="${item?.paid || ''}"></label>
          <label class="field"><span>Vendor <span class="muted">(optional)</span></span><input class="input" name="vendor" maxlength="60" value="${esc(item?.vendor || '')}"></label>
          <label class="field"><span>Payment due <span class="muted">(optional)</span></span><input class="input" type="date" name="dueDate" value="${esc(item?.dueDate || '')}"></label>
          <label class="field"><span>Notes <span class="muted">(optional)</span></span><input class="input" name="note" maxlength="120" value="${esc(item?.note || '')}"></label>
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing ? '<button type="button" class="btn danger" data-m="delete">Delete</button>' : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('.emoji-grid').onclick = (e) => { const b = e.target.closest('[data-emoji]'); if (b) form.icon.value = b.dataset.emoji; };
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = () => {
        if (!confirm(`Delete “${item.name}”?`)) return;
        store.remove('weddingItems', item.id);
        closeModal();
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const err = form.querySelector('.form-error');
        const num = (f) => (f.value.trim() === '' ? 0 : parseAmount(f.value));
        const estimate = num(form.estimate), paid = num(form.paid);
        if (!form.name.value.trim()) { err.textContent = 'Give it a name.'; err.hidden = false; form.name.focus(); return; }
        if (!(estimate >= 0) || !(paid >= 0)) { err.textContent = 'Amounts must be numbers, zero or more.'; err.hidden = false; return; }
        const data = {
          name: form.name.value.trim(), icon: form.icon.value.trim() || '✨', estimate, paid,
          vendor: form.vendor.value.trim(), dueDate: form.dueDate.value || '', note: form.note.value.trim(),
        };
        if (editing) store.update('weddingItems', item.id, data);
        else store.add('weddingItems', { ...data, order: items.length });
        closeModal();
        toast('Saved');
      };
    }

    function payModal(item) {
      const cost = Math.max(Number(item.estimate) || 0, Number(item.paid) || 0);
      const left = round2(cost - (Number(item.paid) || 0));
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>Pay ${esc(item.name)}</h2>
          <p class="muted small">${money(left)} left to pay${item.vendor ? ` to ${esc(item.vendor)}` : ''}.</p>
          <label class="field"><span>Amount paid</span><input class="input amount" name="amount" inputmode="decimal" value="${left > 0 ? left : ''}" autofocus></label>
          <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${todayISO()}"></label>
          <label class="check"><input type="checkbox" name="fromFund" checked><span>Paid from the wedding fund (lowers the fund balance)</span></label>
          <p class="form-error" hidden></p>
          <div class="form-actions"><span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save payment</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      form.onsubmit = (e) => {
        e.preventDefault();
        const v = parseAmount(form.amount.value);
        if (!(v > 0)) { const err = form.querySelector('.form-error'); err.textContent = 'Enter an amount above zero.'; err.hidden = false; return; }
        store.update('weddingItems', item.id, { paid: round2((Number(item.paid) || 0) + v), estimate: Math.max(Number(item.estimate) || 0, round2((Number(item.paid) || 0) + v)) });
        if (form.fromFund.checked) store.add('contributions', { goalId: WEDDING_ID, amount: -v, date: form.date.value || todayISO(), note: `Paid ${item.name}` });
        closeModal();
        toast(`${money(v)} paid to ${item.name}`);
      };
    }

    function fundModal() {
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>Add to wedding fund</h2>
          <label class="field"><span>Amount</span><input class="input amount" name="amount" inputmode="decimal" placeholder="0.00" autofocus></label>
          <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${todayISO()}"></label>
          <label class="field"><span>Note <span class="muted">(optional)</span></span><input class="input" name="note" maxlength="80"></label>
          <p class="form-error" hidden></p>
          <div class="form-actions"><span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Add</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      form.onsubmit = (e) => {
        e.preventDefault();
        const v = parseAmount(form.amount.value);
        if (!(v > 0)) { const err = form.querySelector('.form-error'); err.textContent = 'Enter an amount above zero.'; err.hidden = false; return; }
        store.add('contributions', { goalId: WEDDING_ID, amount: v, date: form.date.value || todayISO(), note: form.note.value.trim() });
        closeModal();
        toast('🎉 Added to the wedding fund');
      };
    }

    function templateModal() {
      const p = plan();
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>Split a budget</h2>
          <p class="muted small">Divides your total across the usual wedding costs. ${items.length ? '<b>This replaces your current list and estimates</b> (payments already recorded are kept on matching names).' : 'You can edit every line afterwards.'}</p>
          <label class="field"><span>Total budget</span><input class="input amount" name="budget" inputmode="decimal" value="${p.budget || ''}" placeholder="0.00" autofocus></label>
          <label class="field"><span>Number of guests</span><input class="input" name="guests" inputmode="numeric" value="${p.guests || ''}" placeholder="0"></label>
          <p class="form-error" hidden></p>
          <div class="form-actions"><span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Create</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      form.onsubmit = (e) => {
        e.preventDefault();
        const budget = parseAmount(form.budget.value);
        const err = form.querySelector('.form-error');
        if (!(budget > 0)) { err.textContent = 'Enter your total budget.'; err.hidden = false; return; }
        const paidByName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
        items.forEach((i) => { if (!TEMPLATE.some(([n]) => n.toLowerCase() === i.name.toLowerCase())) store.remove('weddingItems', i.id); });
        TEMPLATE.forEach(([name, icon, share], order) => {
          const old = paidByName.get(name.toLowerCase());
          const data = { name, icon, estimate: Math.round(budget * share / 100), paid: old?.paid || 0, vendor: old?.vendor || '', dueDate: old?.dueDate || '', note: old?.note || '', order };
          if (old) store.update('weddingItems', old.id, data);
          else store.add('weddingItems', data);
        });
        savePlan({ budget, guests: parseAmount(form.guests.value) || 0 });
        closeModal();
        toast('Budget split. Adjust any line to fit your plans.');
      };
    }

    // ---------- events ----------

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const item = items.find((i) => i.id === b.dataset.id);
      switch (b.dataset.action) {
        case 'add-item': return itemModal(null);
        case 'edit-item': return itemModal(item);
        case 'pay-item': return payModal(item);
        case 'add-fund': return fundModal();
        case 'template': return templateModal();
        default:
      }
    });

    root.addEventListener('change', (e) => {
      const f = e.target.dataset.field;
      if (!f) return;
      hold();
      if (f === 'date') savePlan({ date: e.target.value });
      else {
        const v = e.target.value.trim() === '' ? 0 : parseAmount(e.target.value);
        if (!(v >= 0)) { toast('Enter a number'); return; }
        savePlan({ [f]: v });
      }
    });

    const unsubs = [
      store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); draw(); }),
      store.subscribe('weddingItems', (l) => { items = [...l].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)); draw(); }),
      store.subscribe('contributions', (l) => { contribs = l; draw(); }),
    ];

    sortable(root, {
      list: '.items', item: '.item', handle: '.drag-handle',
      onDrop: (ids) => ids.forEach((id, i) => store.update('weddingItems', id, { order: i })),
      onStart: () => { dragging = true; },
      onEnd: () => { dragging = false; if (dirty) { dirty = false; draw(); } },
    });

    draw();
    return () => unsubs.forEach((u) => u());
  },
};

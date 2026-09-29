import * as store from '../store.js';
import {
  esc, money, parseAmount, todayISO, monthKey, addMonths, monthLabel, openModal, closeModal, toast, toastUndo, confirmDialog,
  renderKeepingFocus, pref, setPref,
} from '../util.js';
import { billOccurrences, billStatus, upcomingBills, addDaysISO, daysBetweenISO, round2 } from '../stats.js';
import { merchantKey } from '../merchant.js';
import { subscribeRecent } from '../alerts.js';
import { dayEvents, involves, freeWindows, fmtTime, toMin, fromMin, assigneesFor } from '../events.js';
import { subscribePeople, roster, personById, me, initial, PERSON_COLORS } from '../people.js';
import { logNotification } from '../notifications.js';
import { createTask, assignTask, acceptTask, declineTask } from '../tasks.js';

// Collections (all inside the household, so everyone in it sees the same things):
//   calendars:     { name, icon, color, members: [uid] (empty = everyone), hideFromDigest (work schedules), order }
//   events:        see js/events.js
//   tasks:         { title, notes, due, assignee ('' = shared), assignedBy, status: open|pending|accepted|done, createdBy, ... }
//   notes:         { type: 'memo'|'list', title, body, items: [{id, text, done}], pinned, calendarId }
//   statuses:      { uid, date, text, emoji }   (id = `${uid}_${date}`)
//   outbox:        { toUid, title, body, link }   pushes waiting for the server job
//   bills / subscriptions: as before
store.registerCollections(['bills', 'subscriptions', 'categories', 'settings', 'calendars', 'events', 'tasks', 'notes', 'statuses', 'outbox', 'people']);

const FREQ = { monthly: 'Monthly', biweekly: 'Every 2 weeks', weekly: 'Weekly', yearly: 'Yearly' };
const STATUS_TEXT = { paid: 'Paid', auto: 'Autopay', late: 'Overdue', soon: 'Due soon', due: 'Upcoming' };
const CAL_COLORS = ['#4f7396', '#0f7f5f', '#b58a2a', '#a4576b', '#6a5bb5', '#dd6b3a', '#3f7d6d', '#5f7280'];
const TEMPLATES = [
  { key: 'family', name: 'Family', icon: '🏠', color: '#4f7396', work: false, justMe: false },
  { key: 'couple', name: 'Couple', icon: '💞', color: '#a4576b', work: false, justMe: false },
  { key: 'work', name: 'Work shifts', icon: '💼', color: '#5f7280', work: true, justMe: true },
  { key: 'hobby', name: 'Hobby group', icon: '🎨', color: '#6a5bb5', work: false, justMe: false },
];
const STATUS_PRESETS = [
  ['🏠', 'Working from home today'], ['👥', 'Out with friends tonight'], ['🌙', 'Working late tonight'], ['✈️', 'Traveling'],
  ['🤒', 'Sick day'], ['🎉', 'Special day'], ['🏋️', 'At the gym'], ['🚗', 'Long drive today'],
];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const shortDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dayName = (iso, today) => (iso === today ? 'Today' : iso === addDaysISO(today, 1) ? 'Tomorrow' : longDay(iso));

const ui = {
  tab: 'calendar', month: monthKey(new Date()), selected: '', money: 'bills', mineOnly: pref('calMine', '0') === '1',
  freeWeek: 0, freePeople: null, freeMin: '60', freeFrom: '08:00', freeTo: '22:00', quickTask: '', quickAssignee: 'me',
};
const hiddenSet = () => { try { return new Set(JSON.parse(pref('calHidden', '[]'))); } catch { return new Set(); } };

export default {
  id: 'calendar',
  title: 'Calendar',
  icon: '📅',
  render(el) {
    const root = document.createElement('div');
    root.className = 'calendar';
    el.appendChild(root);

    let bills = [], subs = [], cats = [], txs = [], settings = {}, calendars = [], events = [], tasks = [], notes = [], statuses = [];
    const myId = () => store.meId();

    const activeBills = () => bills.filter((b) => b.active !== false);
    const isTracked = (s) => activeBills().some((b) => { const k = merchantKey(b.match || b.name); return k && (s.key.startsWith(k) || k.startsWith(s.key)); });
    const calById = (id) => calendars.find((c) => c.id === id);
    const others = () => roster().filter((p) => p.id !== myId());
    const avatar = (p) => `<span class="avatar" style="--pc:${esc(p.color || '#888')}" title="${esc(p.name)}">${esc(initial(p))}</span>`;
    const avatars = (ids) => ids.map((id) => avatar(personById(id))).join('');

    // ---------- shell ----------

    const TABS = [['calendar', 'Calendar'], ['todo', 'To-do'], ['notes', 'Notes'], ['free', 'Free time'], ['money', 'Money']];

    function draw() {
      const waiting = tasks.filter((t) => t.assignee === myId() && t.status === 'pending').length;
      renderKeepingFocus(root, `
        <div class="tabs cal-tabs" role="tablist">
          ${TABS.map(([id, label]) => `<button role="tab" class="tab ${ui.tab === id ? 'active' : ''}" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${label}${id === 'todo' && waiting ? ` <span class="badge warn">${waiting}</span>` : ''}${id === 'money' && changed().length ? ` <span class="badge warn">${changed().length}</span>` : ''}</button>`).join('')}
        </div>
        ${ui.tab === 'calendar' ? calendarTab() : ui.tab === 'todo' ? todoTab() : ui.tab === 'notes' ? notesTab() : ui.tab === 'free' ? freeTab() : moneyTab()}`);
      renderTopStatus();
    }

    // =====================================================================
    // Calendar tab
    // =====================================================================

    function visibleFor(date) {
      const hide = hiddenSet();
      return dayEvents(events.filter((e) => !hide.has(e.calendarId)), calendars, date)
        .filter((it) => !ui.mineOnly || involves(it.assignees, it.cal, myId()));
    }
    const tasksOn = (date) => tasks.filter((t) => t.due === date && (!ui.mineOnly || !t.assignee || t.assignee === myId()));

    // ----- status (shown at the top of the screen, next to the bell) -----

    // What someone is doing right now, worked out from the calendar: at work, likely driving (within 30 minutes of a
    // work shift starting or ending), or the event happening at this moment.
    function autoStatus(uid) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      let atWork = false, driving = false, current = null;
      for (const it of dayEvents(events, calendars, todayISO())) {
        if (!it.ev.start || (it.ev.done || {})[it.date] || !involves(it.assignees, it.cal, uid)) continue;
        const st = toMin(it.ev.start);
        const en = it.ev.end ? toMin(it.ev.end) : st + 60;
        const work = !!it.cal?.hideFromDigest;
        if (nowMin >= st && nowMin < en) { if (work) atWork = true; else current ||= it; }
        else if (work && ((nowMin >= st - 30 && nowMin < st) || (nowMin >= en && nowMin < en + 30))) driving = true;
      }
      if (atWork) return { emoji: '💼', text: 'At work', auto: true };
      if (driving) return { emoji: '🚗', text: 'Likely driving', auto: true };
      if (current) return { emoji: current.cal?.icon || '📌', text: current.ev.title, auto: true };
      return null;
    }
    const statusOf = (uid) => statuses.find((x) => x.uid === uid && x.date === todayISO()) || autoStatus(uid);

    const topBtn = document.createElement('button');
    topBtn.className = 'top-status';
    topBtn.type = 'button';
    topBtn.setAttribute('data-status-btn', '');
    topBtn.onclick = () => statusModal(todayISO());
    document.querySelector('.top-actions')?.prepend(topBtn);
    function renderTopStatus() {
      const mine = statusOf(myId());
      const partners = others().map((p) => ({ p, st: statusOf(p.id) })).filter((x) => x.st);
      topBtn.innerHTML = `${mine ? `<span aria-hidden="true">${esc(mine.emoji || '💬')}</span><span class="ts-text">${esc(mine.text)}</span>` : '<span class="ts-text">＋ Status</span>'}${partners.map(({ p, st }) => `<span class="ts-partner" title="${esc(p.name)}: ${esc(st.text)}"><b style="background:${esc(p.color || '#888')}">${esc(initial(p))}</b>${esc(st.emoji || '')}</span>`).join('')}`;
      topBtn.title = mine ? `My status: ${mine.text}${mine.auto ? ' (from the calendar)' : ''}` : 'Set my status';
    }
    const tick = setInterval(renderTopStatus, 60000);

    function filterBar() {
      const hide = hiddenSet();
      if (!calendars.length) return '';
      return `
        <div class="cal-filters" role="group" aria-label="Show or hide calendars">
          ${calendars.map((c) => `<button class="fchip ${hide.has(c.id) ? 'off' : ''}" style="--cc:${esc(c.color)}" aria-pressed="${!hide.has(c.id)}" data-action="toggle-cal" data-id="${esc(c.id)}"><i class="fdot"></i>${esc(c.icon || '')} ${esc(c.name)}</button>`).join('')}
          <button class="fchip ${hide.has('bills') ? 'off' : ''}" style="--cc:var(--gold)" aria-pressed="${!hide.has('bills')}" data-action="toggle-cal" data-id="bills"><i class="fdot"></i>💰 Bills</button>
          <button class="fchip mine ${ui.mineOnly ? '' : 'off'}" aria-pressed="${ui.mineOnly}" data-action="mine-only">Just me</button>
          <button class="fchip add" data-action="manage-cals">⚙ Calendars</button>
        </div>`;
    }

    function onboarding() {
      return `
        <section class="card intro">
          <h2>Make your first calendar</h2>
          <p class="muted">Keep separate calendars for different groups (family, a couple's calendar, work shifts, a hobby group) and see them all together or one at a time.</p>
          <div class="starters">${TEMPLATES.map((t, i) => `<button class="starter" data-action="new-cal" data-template="${i}"><span>${t.icon}</span>${esc(t.name)}</button>`).join('')}</div>
        </section>`;
    }

    function calendarTab() {
      const today = todayISO();
      const sel = ui.selected || today;
      if (!calendars.length) return `${onboarding()}${billsOnlyGrid(sel)}`;
      return `${filterBar()}${monthCard(sel)}${agendaCard(sel)}`;
    }
    const billsOnlyGrid = (sel) => (activeBills().length ? monthCard(sel) + agendaCard(sel) : '');

    function monthCard(sel) {
      const [y, m] = ui.month.split('-').map(Number);
      const days = new Date(y, m, 0).getDate();
      const startDow = new Date(y, m - 1, 1).getDay();
      const gridDays = Math.ceil((startDow + days) / 7) * 7;
      const isoOf = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const gridFirst = isoOf(new Date(y, m - 1, 1 - startDow));
      const gridLast = isoOf(new Date(y, m - 1, gridDays - startDow));
      const today = todayISO();
      const hide = hiddenSet();
      const billsByDay = {};
      if (!hide.has('bills')) {
        for (const b of activeBills()) {
          for (const due of billOccurrences(b, gridFirst, gridLast)) (billsByDay[due] ||= []).push({ bill: b, due, status: billStatus(b, due, txs, today) });
        }
      }
      const wedDate = settings.wedding?.date;
      const cells = [];
      for (let i = 0; i < gridDays; i++) {
        const cd = new Date(y, m - 1, 1 - startDow + i);
        const date = isoOf(cd);
        const d = cd.getDate();
        const outside = cd.getMonth() !== m - 1;
        const evs = visibleFor(date);
        const bs = billsByDay[date] || [];
        const ts = tasksOn(date).filter((t) => t.status !== 'done');
        const dots = [
          ...evs.map((it) => `<i class="dot" style="background:${esc(it.cal?.color || '#888')}"></i>`),
          ...bs.map((i) => `<i class="dot ${i.status === 'paid' ? 'paid' : i.status === 'late' ? 'late' : i.status === 'auto' ? 'auto' : 'due'}"></i>`),
          ...ts.map(() => '<i class="dot task"></i>'),
        ];
        const pills = [
          ...evs.map((it) => `<span class="cal-pill ev" style="--cc:${esc(it.cal?.color || '#888')}">${esc(it.ev.start ? `${fmtTime(it.ev.start).replace(/ ?[AP]M/i, '')} ` : '')}${esc(it.ev.title)}</span>`),
          ...bs.map((i) => `<span class="cal-pill ${i.status === 'paid' ? 'paid' : i.status === 'late' ? 'late' : i.status === 'auto' ? 'auto' : 'due'}">${esc(i.bill.name)}</span>`),
          ...ts.map((t) => `<span class="cal-pill task">☐ ${esc(t.title)}</span>`),
        ];
        const total = evs.length + bs.length + ts.length;
        cells.push(`
          <button class="cal-day ${date === today ? 'today' : ''} ${date === sel ? 'selected' : ''} ${outside ? 'outside' : ''}" data-action="pick-day" data-date="${date}"
            aria-label="${esc(longDay(date))}${total ? `, ${plural(total, 'item')}` : ''}">
            <span class="dn">${d}${wedDate === date ? '💍' : ''}</span>
            ${pills.slice(0, 3).join('')}
            ${pills.length > 3 ? `<span class="cal-pill more">+${pills.length - 3} more</span>` : ''}
          </button>`);
      }
      return `
        <section class="card cal-full">
          <div class="cal-head">
            <button class="icon-btn" data-action="prev-month" aria-label="Previous month">‹</button>
            <h2>${esc(monthLabel(ui.month))}</h2>
            <button class="icon-btn" data-action="next-month" aria-label="Next month">›</button>
          </div>
          <div class="cal-grid" role="grid">
            ${DOW.map((d) => `<span class="cal-dow">${d}</span>`).join('')}
            ${cells.join('')}
          </div>
          <div class="cal-legend"><button class="link" data-action="today">Jump to today</button></div>
        </section>`;
    }

    function eventRow(it, today) {
      const { ev, date, assignees, cal } = it;
      const done = !!ev.done?.[date];
      const mine = myId();
      const turn = ev.rotation?.order?.length && assignees[0]
        ? `<span class="turn ${assignees[0] === mine ? 'mine' : ''}">${assignees[0] === mine ? 'Your turn' : `${esc(personById(assignees[0]).name)}'s turn`}</span>` : '';
      const forWho = assignees.length ? avatars(assignees)
        : cal?.members?.length ? avatars(cal.members) : '<span class="small muted">Everyone</span>';
      return `
        <div class="agenda-item ${done ? 'done' : ''}" style="--cc:${esc(cal?.color || '#888')}">
          <button class="check-circle ${done ? 'on' : ''}" data-action="toggle-done" data-id="${esc(ev.id)}" data-date="${date}" aria-label="${done ? 'Mark not done' : 'Mark done'}" aria-pressed="${done}">${done ? '✓' : ''}</button>
          <button class="agenda-main" data-action="edit-event" data-id="${esc(ev.id)}" data-date="${date}">
            <span class="agenda-time">${ev.start ? `${esc(fmtTime(ev.start))}${ev.end ? ` – ${esc(fmtTime(ev.end))}` : ''}` : 'All day'}</span>
            <span class="agenda-title">${esc(ev.title)} ${turn}</span>
            <span class="small muted">${esc(cal?.icon || '')} ${esc(cal?.name || 'Calendar')}${ev.notes ? ` · ${esc(ev.notes.slice(0, 60))}` : ''}</span>
          </button>
          <span class="agenda-who">${forWho}</span>
          ${ev.rotation?.order?.length > 1 ? `<button class="btn sm" data-action="swap-turn" data-id="${esc(ev.id)}" data-date="${date}" title="Give this one to the next person">Swap</button>` : ''}
        </div>`;
    }

    function taskChips(t) {
      const parts = [];
      if (t.assignee) parts.push(`${avatar(personById(t.assignee))}`);
      if (t.due) parts.push(`<span class="small muted">due ${esc(shortDay(t.due))}</span>`);
      return parts.join(' ');
    }

    function agendaCard(sel) {
      const today = todayISO();
      const evs = visibleFor(sel);
      const ts = tasksOn(sel);
      const hide = hiddenSet();
      const bs = hide.has('bills') ? [] : activeBills().flatMap((b) => billOccurrences(b, sel, sel).map((due) => ({ bill: b, due, status: billStatus(b, due, txs, today) })));
      const empty = !evs.length && !ts.length && !bs.length;
      return `
        <section class="card">
          <div class="card-head"><h2>${esc(dayName(sel, today))}</h2>
            <span class="btn-row"><button class="btn sm primary" data-action="add-event" data-date="${sel}">+ Event</button><button class="btn sm" data-action="add-task-on" data-date="${sel}">+ Task</button></span></div>
          ${evs.map((it) => eventRow(it, today)).join('')}
          ${ts.map((t) => taskRow(t, true)).join('')}
          ${bs.map((i) => billRow(i.bill, i.due, i.status)).join('')}
          ${empty ? '<p class="muted small">Nothing scheduled.</p>' : ''}
        </section>`;
    }

    // =====================================================================
    // To-do tab: tasks you can hand to someone with one tap
    // =====================================================================

    function taskRow(t, compact = false) {
      const mine = t.assignee === myId();
      const done = t.status === 'done';
      const bySomeoneElse = t.assignedBy && t.assignedBy !== myId();
      return `
        <div class="task ${done ? 'done' : ''}">
          <button class="check-circle ${done ? 'on' : ''}" data-action="toggle-task" data-id="${esc(t.id)}" aria-label="${done ? 'Mark not done' : 'Mark done'}" aria-pressed="${done}">${done ? '✓' : ''}</button>
          <span class="task-main">
            <button class="task-title" data-action="edit-task" data-id="${esc(t.id)}">${esc(t.title)}</button>
            <span class="task-meta">${taskChips(t)}${t.status === 'pending' && mine && bySomeoneElse ? ` <span class="small muted">from ${esc(personById(t.assignedBy).name)}</span>` : ''}${t.declinedBy ? ` <span class="st late">${esc(personById(t.declinedBy).name)} passed</span>` : ''}${t.status === 'pending' && !mine && t.assignee ? ' <span class="st due">Waiting for them</span>' : ''}${t.status === 'accepted' && !mine ? ' <span class="st paid">Accepted</span>' : ''}</span>
            ${t.notes && !compact ? `<span class="small muted">${esc(t.notes.slice(0, 80))}</span>` : ''}
          </span>
          <span class="task-actions">
            ${t.status === 'pending' && mine ? `<button class="btn sm primary" data-action="accept-task" data-id="${esc(t.id)}">Accept</button><button class="btn sm" data-action="decline-task" data-id="${esc(t.id)}">Not today</button>` : ''}
            ${!done && !compact ? others().filter((p) => p.id !== t.assignee).slice(0, 3).map((p) => `<button class="btn sm handoff" data-action="give-task" data-id="${esc(t.id)}" data-to="${esc(p.id)}" title="Give this task to ${esc(p.name)}">→ ${esc(p.name)}</button>`).join('') : ''}
            ${!done && !compact && t.assignee && t.assignee !== myId() ? `<button class="btn sm" data-action="give-task" data-id="${esc(t.id)}" data-to="${esc(myId())}">→ Me</button>` : ''}
          </span>
        </div>`;
    }

    function todoTab() {
      const meId = myId();
      const open = tasks.filter((t) => t.status !== 'done');
      const sortT = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.createdAt || 0) - (b.createdAt || 0);
      const waiting = open.filter((t) => t.assignee === meId && t.status === 'pending').sort(sortT);
      const mine = open.filter((t) => t.assignee === meId && t.status !== 'pending').sort(sortT);
      const shared = open.filter((t) => !t.assignee).sort(sortT);
      const given = open.filter((t) => t.assignee && t.assignee !== meId).sort(sortT);
      const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 10);
      const section = (title, list, hint = '') => (list.length ? `<section class="card"><div class="card-head"><h2>${title}</h2>${hint ? `<span class="muted small">${hint}</span>` : ''}</div>${list.map((t) => taskRow(t)).join('')}</section>` : '');
      const who = roster();
      return `
        <section class="card">
          <div class="card-head"><h2>Add a task</h2></div>
          <div class="quick-row task-add">
            <input class="input" placeholder="e.g. Pick up groceries" maxlength="80" value="${esc(ui.quickTask)}" data-quick-task data-focus-key="quick-task" aria-label="New task">
            <select class="input" data-quick-assignee aria-label="Who is it for">
              <option value="me" ${ui.quickAssignee === 'me' ? 'selected' : ''}>Me</option>
              ${others().map((p) => `<option value="${esc(p.id)}" ${ui.quickAssignee === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
              <option value="" ${ui.quickAssignee === '' ? 'selected' : ''}>Anyone</option>
            </select>
            <button class="btn primary" data-action="add-task">Add</button>
          </div>
          <p class="muted small">Pick <b>${who.length > 1 ? esc(others()[0]?.name || 'someone') : 'someone'}</b> and it lands on their day right away, with a notification. They can accept it or pass it back.</p>
        </section>
        ${section('Waiting for you', waiting, 'Accept or pass')}
        ${section('Your to-do', mine)}
        ${section('Shared', shared, 'Anyone can grab these')}
        ${section('Handed to others', given)}
        ${!open.length ? '<p class="muted small">Nothing to do. Enjoy it.</p>' : ''}
        ${done.length ? `<details class="card"><summary>Done (${done.length})</summary>${done.map((t) => taskRow(t)).join('')}</details>` : ''}`;
    }

    // =====================================================================
    // Notes tab: shared memos and lists, not tied to a date
    // =====================================================================

    function notesTab() {
      const hide = hiddenSet();
      const list = notes.filter((n) => !n.calendarId || !hide.has(n.calendarId))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
      return `
        <section class="card">
          <div class="card-head"><h2>Notes & lists</h2>
            <span class="btn-row"><button class="btn sm primary" data-action="new-note" data-type="list">+ List</button><button class="btn sm" data-action="new-note" data-type="memo">+ Memo</button></span></div>
          <p class="muted small">Shared with everyone in the household. Not tied to a date: grocery lists, packing lists, things to remember.</p>
        </section>
        <div class="notes-grid">
          ${list.map((n) => n.type === 'list' ? listCard(n) : memoCard(n)).join('')}
        </div>
        ${!list.length ? '<p class="muted">No notes yet. Start a list or write a memo.</p>' : ''}`;
    }

    function memoCard(n) {
      return `
        <article class="note ${n.pinned ? 'pinned' : ''}">
          <div class="note-head"><button class="note-title" data-action="edit-note" data-id="${esc(n.id)}">${esc(n.title || 'Untitled memo')}</button>
            <button class="pin ${n.pinned ? 'on' : ''}" data-action="pin-note" data-id="${esc(n.id)}" aria-label="${n.pinned ? 'Unpin' : 'Pin'}" aria-pressed="${!!n.pinned}">📌</button></div>
          <button class="note-body" data-action="edit-note" data-id="${esc(n.id)}">${esc(n.body || 'Tap to write…')}</button>
          ${n.calendarId ? `<span class="small muted">${esc(calById(n.calendarId)?.icon || '')} ${esc(calById(n.calendarId)?.name || '')}</span>` : ''}
        </article>`;
    }

    function listCard(n) {
      const items = n.items || [];
      const left = items.filter((i) => !i.done).length;
      return `
        <article class="note list ${n.pinned ? 'pinned' : ''}">
          <div class="note-head"><button class="note-title" data-action="edit-note" data-id="${esc(n.id)}">${esc(n.title || 'List')}</button>
            <span class="small muted">${left} left</span>
            <button class="pin ${n.pinned ? 'on' : ''}" data-action="pin-note" data-id="${esc(n.id)}" aria-label="${n.pinned ? 'Unpin' : 'Pin'}" aria-pressed="${!!n.pinned}">📌</button></div>
          <ul class="checklist">
            ${items.map((i) => `<li class="${i.done ? 'done' : ''}"><label><input type="checkbox" data-list-item="${esc(i.id)}" data-note="${esc(n.id)}" ${i.done ? 'checked' : ''}><span>${esc(i.text)}</span></label>
              <button class="link danger" data-action="del-item" data-note="${esc(n.id)}" data-item="${esc(i.id)}" aria-label="Remove ${esc(i.text)}">✕</button></li>`).join('')}
          </ul>
          <input class="input add-item" placeholder="Add an item" maxlength="80" data-add-item="${esc(n.id)}" data-focus-key="add-${esc(n.id)}" aria-label="Add an item to ${esc(n.title || 'list')}">
          ${items.some((i) => i.done) ? `<button class="link" data-action="clear-done" data-id="${esc(n.id)}">Clear checked items</button>` : ''}
        </article>`;
    }

    // =====================================================================
    // Free-time finder
    // =====================================================================

    function freeTab() {
      const today = todayISO();
      const who = roster();
      // Everyone by default (even if profiles arrive late); once you toggle someone, your choice sticks.
      const picked = ui.freeCustom ? (ui.freePeople || []).filter((id) => who.some((p) => p.id === id)) : who.map((p) => p.id);
      const start = addDaysISO(today, ui.freeWeek * 7);
      const rows = Array.from({ length: 7 }, (_, i) => addDaysISO(start, i)).map((date) => ({
        date, wins: picked.length ? freeWindows(events, calendars, picked, date, { from: ui.freeFrom, to: ui.freeTo, min: Number(ui.freeMin) }) : [],
      }));
      const dates = rows.reduce((n, r) => n + r.wins.filter((w) => w.label === 'date').length, 0);
      return `
        <section class="card">
          <div class="card-head"><h2>Shared free time</h2></div>
          <p class="muted small">Finds the gaps when everyone you pick is free at once. Only timed events count as busy. Work shifts are included.</p>
          <div class="chips free-people" role="group" aria-label="Who">
            ${who.map((p) => `<button class="fchip ${picked.includes(p.id) ? '' : 'off'}" style="--cc:${esc(p.color || '#888')}" aria-pressed="${picked.includes(p.id)}" data-action="free-person" data-id="${esc(p.id)}"><i class="fdot"></i>${esc(p.name)}${p.id === myId() ? ' (you)' : ''}</button>`).join('')}
          </div>
          <div class="free-opts">
            <label class="field"><span>At least</span><select class="input" data-free="freeMin">${[['30', '30 min'], ['60', '1 hour'], ['90', '1½ hours'], ['120', '2 hours'], ['180', '3 hours']].map(([v, l]) => `<option value="${v}" ${ui.freeMin === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field"><span>From</span><input class="input" type="time" value="${ui.freeFrom}" data-free="freeFrom"></label>
            <label class="field"><span>Until</span><input class="input" type="time" value="${ui.freeTo}" data-free="freeTo"></label>
          </div>
        </section>
        <section class="card">
          <div class="cal-head"><button class="icon-btn" data-action="free-prev" aria-label="Earlier week">‹</button>
            <h2>${esc(shortDay(start))} – ${esc(shortDay(addDaysISO(start, 6)))}</h2>
            <button class="icon-btn" data-action="free-next" aria-label="Later week">›</button></div>
          ${picked.length ? `<p class="small ${dates ? 'good' : 'muted'}">${dates ? `🍷 ${plural(dates, 'date night opportunity')} this week` : 'No long evening gaps this week.'}</p>` : '<p class="muted small">Pick at least one person.</p>'}
          ${rows.map((r) => `
            <div class="free-day">
              <div class="free-date">${esc(dayName(r.date, today))}</div>
              ${r.wins.length ? r.wins.map((w) => `
                <div class="free-win ${w.label}">
                  <span>${w.label === 'date' ? '🍷 Date night opportunity' : '🕒 Joint free time'}</span>
                  <b>${esc(fmtTime(w.start))} – ${esc(fmtTime(w.end))}</b>
                  <span class="small muted">${w.minutes >= 60 ? `${Math.floor(w.minutes / 60)} h${w.minutes % 60 ? ` ${w.minutes % 60} m` : ''}` : `${w.minutes} m`}</span>
                  <button class="btn sm" data-action="plan-free" data-date="${r.date}" data-start="${w.start}" data-end="${w.end}" data-label="${w.label}">Plan it</button>
                </div>`).join('') : '<div class="small muted">No shared gap.</div>'}
            </div>`).join('')}
        </section>`;
    }

    // =====================================================================
    // Money tab (bills + subscriptions)
    // =====================================================================

    function moneyTab() {
      return `
        <div class="tabs cal-tabs sub-tabs" role="tablist">
          ${[['bills', 'Bills'], ['subs', 'Subscriptions']].map(([id, label]) => `<button role="tab" class="tab ${ui.money === id ? 'active' : ''}" aria-selected="${ui.money === id}" data-action="money-tab" data-tab="${id}">${label}</button>`).join('')}
        </div>
        ${ui.money === 'bills' ? billsTab() : subsTab()}`;
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

    function billsTab() {
      const today = todayISO();
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
              <span class="sub-price">${money(s.amount)}<br><span class="small muted">${s.frequency === 'yearly' || s.frequency === 'quarterly' ? `${money(s.monthly)}/mo` : `${money(s.amount * 12)}/yr`}</span></span>
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

    // =====================================================================
    // Modals
    // =====================================================================

    const peopleChecks = (name, selected, all = roster()) => all.map((p) => `
      <label class="pick"><input type="checkbox" name="${name}" value="${esc(p.id)}" ${selected.includes(p.id) ? 'checked' : ''}><span class="avatar" style="--pc:${esc(p.color || '#888')}">${esc(initial(p))}</span><span>${esc(p.name)}${p.id === myId() ? ' (you)' : ''}</span></label>`).join('');

    // ----- calendars -----

    function manageCalsModal() {
      const dlg = openModal(`
        <div class="form">
          <h2>Calendars</h2>
          ${calendars.length ? `<div class="cal-list">${calendars.map((c) => `
            <button class="cal-row" data-cal="${esc(c.id)}" style="--cc:${esc(c.color)}"><i class="fdot"></i>
              <span class="cal-row-main"><b>${esc(c.icon || '')} ${esc(c.name)}</b><span class="small muted">${c.members?.length ? c.members.map((id) => esc(personById(id).name)).join(', ') : 'Everyone'}${c.hideFromDigest ? ' · left out of the morning summary' : ''}</span></span>
              <span class="chev">›</span></button>`).join('')}</div>` : '<p class="muted">No calendars yet.</p>'}
          <p class="small muted">Start from a template:</p>
          <div class="starters">${TEMPLATES.map((t, i) => `<button class="starter" data-template="${i}"><span>${t.icon}</span>${esc(t.name)}</button>`).join('')}</div>
          <div class="form-actions"><button type="button" class="btn" data-m="people">Edit my name & color</button><span class="spacer"></span><button type="button" class="btn primary" data-m="close">Done</button></div>
        </div>`);
      dlg.querySelector('[data-m=close]').onclick = closeModal;
      dlg.querySelector('[data-m=people]').onclick = () => profileModal();
      dlg.querySelectorAll('[data-cal]').forEach((b) => { b.onclick = () => calModal(calById(b.dataset.cal)); });
      dlg.querySelectorAll('[data-template]').forEach((b) => { b.onclick = () => calModal(null, TEMPLATES[Number(b.dataset.template)]); });
    }

    function calModal(cal, template) {
      const editing = !!cal;
      const t = template || {};
      const c = cal || { name: t.name || '', icon: t.icon || '📅', color: t.color || CAL_COLORS[calendars.length % CAL_COLORS.length], members: t.justMe ? [myId()] : [], hideFromDigest: !!t.work };
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit calendar' : 'New calendar'}</h2>
          <div class="field-row">
            <label class="field icon-field"><span>Icon</span><input class="input emoji-input" name="icon" maxlength="8" value="${esc(c.icon)}"></label>
            <label class="field grow"><span>Name</span><input class="input" name="name" maxlength="30" value="${esc(c.name)}" placeholder="e.g. Family" ${editing ? '' : 'autofocus'}></label>
          </div>
          <div class="field"><span>Color</span><div class="swatch-row">${CAL_COLORS.map((col) => `<label class="cswatch"><input type="radio" name="color" value="${col}" ${c.color === col ? 'checked' : ''}><i style="background:${col}"></i></label>`).join('')}</div></div>
          <div class="field"><span>Who is in it?</span>
            <label class="check"><input type="checkbox" name="everyone" ${!c.members?.length ? 'checked' : ''}><span>Everyone in the household</span></label>
            <div class="picks" data-picks ${!c.members?.length ? 'hidden' : ''}>${peopleChecks('member', c.members || [])}</div></div>
          <label class="check"><input type="checkbox" name="work" ${c.hideFromDigest ? 'checked' : ''}><span><b>Leave out of my morning summary</b><br><span class="muted small">Handy for work schedules. It still shows on the calendar and counts as busy time.</span></span></label>
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing && e0.repeat && e0.repeat !== 'none' && prefill.occ ? `<button type="button" class="btn" data-m="skip">Skip ${esc(shortDay(prefill.occ))} only</button>` : ''}
            ${editing ? `<button type="button" class="btn danger" data-m="delete">${e0.repeat && e0.repeat !== 'none' ? 'Delete all' : 'Delete'}</button>` : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      form.everyone.onchange = () => { form.querySelector('[data-picks]').classList.toggle('dim', form.everyone.checked); };
      form.querySelector('[data-m=cancel]').onclick = () => manageCalsModal();
      const skip = form.querySelector('[data-m=skip]');
      if (skip) skip.onclick = () => {
        const before = ev.exceptions || {};
        store.update('events', ev.id, { exceptions: { ...before, [prefill.occ]: true } });
        closeModal();
        toastUndo(`Skipped ${shortDay(prefill.occ)}`, () => store.update('events', ev.id, { exceptions: { ...before, [prefill.occ]: false } }));
      };
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = async () => {
        const mine = events.filter((e) => e.calendarId === cal.id);
        if (!(await confirmDialog({ title: `Delete “${cal.name}”?`, body: `${plural(mine.length, 'event')} on it will be deleted too.` }))) { calModal(cal); return; }
        const copy = { ...cal }, copies = mine.map((e) => ({ ...e }));
        mine.forEach((e) => store.remove('events', e.id));
        store.remove('calendars', cal.id);
        toastUndo(`${copy.name} deleted`, () => { store.put('calendars', copy.id, copy); copies.forEach((e) => store.put('events', e.id, e)); });
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const err = form.querySelector('.form-error');
        if (!form.name.value.trim()) { err.textContent = 'Give the calendar a name.'; err.hidden = false; form.name.focus(); return; }
        const members = form.everyone.checked ? [] : [...form.querySelectorAll('input[name=member]:checked')].map((i) => i.value);
        if (!form.everyone.checked && !members.length) { err.textContent = 'Pick at least one person, or choose Everyone.'; err.hidden = false; return; }
        const data = {
          name: form.name.value.trim(), icon: form.icon.value.trim() || '📅', color: form.querySelector('input[name=color]:checked')?.value || CAL_COLORS[0],
          members, hideFromDigest: form.work.checked,
        };
        if (editing) store.update('calendars', cal.id, data);
        else store.add('calendars', { ...data, order: calendars.length });
        toast('Saved');
        manageCalsModal();
      };
    }

    function profileModal() {
      const p = me();
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>Your name & color</h2>
          <p class="muted small">This is how you show up on shared calendars, tasks and status.</p>
          <label class="field"><span>Name</span><input class="input" name="name" maxlength="20" value="${esc(p.name)}"></label>
          <div class="field"><span>Color</span><div class="swatch-row">${PERSON_COLORS.map((col) => `<label class="cswatch"><input type="radio" name="color" value="${col}" ${p.color === col ? 'checked' : ''}><i style="background:${col}"></i></label>`).join('')}</div></div>
          <label class="check"><input type="checkbox" name="digest" ${p.digest === false ? '' : 'checked'}><span><b>Morning summary</b><br><span class="muted small">A notification around 7 AM with today's events and tasks. Work calendars are left out.</span></span></label>
          <div class="form-actions"><span class="spacer"></span><button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = () => manageCalsModal();
      form.onsubmit = (e) => {
        e.preventDefault();
        store.put('people', myId(), { ...p, id: undefined, name: form.name.value.trim() || p.name, color: form.querySelector('input[name=color]:checked')?.value || p.color, digest: form.digest.checked, createdAt: p.createdAt || Date.now() });
        toast('Saved');
        closeModal();
      };
    }

    // ----- status -----

    function statusModal(date) {
      const current = statuses.find((s) => s.uid === myId() && s.date === date);
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>My status for ${esc(dayName(date, todayISO()).toLowerCase())}</h2>
          <p class="muted small">A quick heads-up everyone can see at the top of the screen. If you don't set one, it follows your calendar: what you're in right now, or “Likely driving” within 30 minutes of a work shift (for calendars marked as work).</p>
          <div class="cat-menu">${STATUS_PRESETS.map(([e, t]) => `<button type="button" class="cat-choice ${current?.text === t ? 'current' : ''}" data-emoji="${esc(e)}" data-text="${esc(t)}"><span aria-hidden="true">${esc(e)}</span><span>${esc(t)}</span></button>`).join('')}</div>
          <div class="field-row"><label class="field icon-field"><span>Icon</span><input class="input emoji-input" name="emoji" maxlength="4" value="${esc(current?.emoji || '')}"></label>
            <label class="field grow"><span>Or write your own</span><input class="input" name="text" maxlength="50" value="${esc(current?.text || '')}" placeholder="e.g. Dentist at 3"></label></div>
          <div class="form-actions">${current ? '<button type="button" class="btn" data-m="clear">Clear</button>' : ''}<span class="spacer"></span><button type="button" class="btn" data-m="cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>
        </form>`);
      const form = dlg.querySelector('form');
      dlg.querySelectorAll('.cat-choice').forEach((b) => { b.onclick = () => { form.emoji.value = b.dataset.emoji; form.text.value = b.dataset.text; form.requestSubmit(); }; });
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      form.querySelector('[data-m=clear]')?.addEventListener('click', () => { store.remove('statuses', `${myId()}_${date}`); closeModal(); toast('Status cleared'); });
      form.onsubmit = (e) => {
        e.preventDefault();
        if (!form.text.value.trim()) { toast('Write a status or pick one'); return; }
        store.put('statuses', `${myId()}_${date}`, { uid: myId(), date, text: form.text.value.trim(), emoji: form.emoji.value.trim() });
        closeModal();
        toast('Status set');
      };
    }

    // ----- events -----

    function eventModal(ev, prefill = {}) {
      const editing = !!ev;
      if (!calendars.length) { toast('Create a calendar first'); manageCalsModal(); return; }
      const e0 = ev || {
        calendarId: prefill.calendarId || calendars.find((c) => !hiddenSet().has(c.id))?.id || calendars[0].id, title: prefill.title || '',
        date: prefill.date || ui.selected || todayISO(), endDate: '', start: prefill.start ?? '09:00', end: prefill.end ?? '10:00',
        assignees: [], repeat: 'none', every: 1, weekdays: [], until: '', notes: '', rotation: null,
      };
      const allDay = !e0.start;
      const participants = roster();
      const rotOrder = e0.rotation?.order || [];
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit event' : 'New event'}</h2>
          <label class="field"><span>What</span><input class="input" name="title" maxlength="60" value="${esc(e0.title)}" placeholder="e.g. Dentist, Trash night, Shift" ${editing ? '' : 'autofocus'}></label>
          <label class="field"><span>Calendar</span><select class="input" name="calendarId">${calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === e0.calendarId ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('')}</select></label>
          <div class="field-row">
            <label class="field grow"><span>Date</span><input class="input" type="date" name="date" value="${esc(e0.date)}"></label>
            <label class="field grow" data-enddate><span>Ends <span class="muted">(multi-day)</span></span><input class="input" type="date" name="endDate" value="${esc(e0.endDate || '')}"></label>
          </div>
          <label class="check"><input type="checkbox" name="allday" ${allDay ? 'checked' : ''}><span>All day</span></label>
          <div class="field-row" data-times ${allDay ? 'hidden' : ''}>
            <label class="field grow"><span>Starts</span><input class="input" type="time" name="start" value="${esc(e0.start || '09:00')}"></label>
            <label class="field grow"><span>Ends</span><input class="input" type="time" name="end" value="${esc(e0.end || '')}"></label>
          </div>
          <div class="field"><span>Who is it for?</span>
            <label class="check"><input type="checkbox" name="everyone" ${!e0.assignees?.length && !e0.rotation ? 'checked' : ''}><span>Everyone in the calendar</span></label>
            ${participants.length < 2 ? '<p class="muted small">Your partner shows up here once they have opened the Calendar tab on their own device.</p>' : ''}
            <div class="picks" data-picks>${peopleChecks('who', e0.assignees || [], participants)}</div></div>
          <label class="field"><span>Repeats</span>
            <select class="input" name="repeat">${[['none', 'Doesn’t repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([v, l]) => `<option value="${v}" ${e0.repeat === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <div data-repeat-opts hidden>
            <div class="field" data-weekdays><span>On</span><div class="dow-row">${DOW.map((d, i) => `<label class="dow"><input type="checkbox" name="wd" value="${i}" ${(e0.weekdays || []).includes(i) ? 'checked' : ''}><span>${d.slice(0, 2)}</span></label>`).join('')}</div></div>
            <div class="field-row">
              <label class="field grow"><span>Every</span><select class="input" name="every">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(e0.every || 1) === n ? 'selected' : ''}>${n === 1 ? 'time' : `${n} times`}</option>`).join('')}</select></label>
              <label class="field grow"><span>Until <span class="muted">(optional)</span></span><input class="input" type="date" name="until" value="${esc(e0.until || '')}"></label>
            </div>
            <label class="check"><input type="checkbox" name="rotate" ${e0.rotation ? 'checked' : ''}><span><b>Take turns</b><br><span class="muted small">It moves to the next person each time, so nobody has to remember whose turn it is.</span></span></label>
            <div data-rotation ${e0.rotation ? '' : 'hidden'}>
              <div class="field"><span>Taking turns</span><div class="picks">${peopleChecks('turn', rotOrder, participants)}</div></div>
              <div class="field-row">
                <label class="field grow"><span>First up</span><select class="input" name="first">${participants.map((p) => `<option value="${esc(p.id)}" ${rotOrder[0] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
                <label class="field grow"><span>Switch</span><select class="input" name="by"><option value="time" ${e0.rotation?.by !== 'week' ? 'selected' : ''}>Each time it happens</option><option value="week" ${e0.rotation?.by === 'week' ? 'selected' : ''}>Every week</option></select></label>
              </div>
            </div>
          </div>
          <label class="field"><span>Notes <span class="muted">(optional)</span></span><textarea class="input" name="notes" rows="2" maxlength="300">${esc(e0.notes || '')}</textarea></label>
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
        form.querySelector('[data-times]').hidden = form.allday.checked;
        const rep = form.repeat.value;
        form.querySelector('[data-repeat-opts]').hidden = rep === 'none';
        form.querySelector('[data-weekdays]').hidden = rep !== 'weekly';
        form.querySelector('[data-enddate]').hidden = rep !== 'none';
        form.querySelector('[data-picks]').classList.toggle('dim', form.everyone.checked);
        form.querySelector('[data-rotation]').hidden = !form.rotate.checked;
        form.everyone.disabled = form.rotate.checked && rep !== 'none';
      };
      sync();
      form.querySelector('[data-picks]').addEventListener('change', (ev2) => {
        if (ev2.target.name === 'who' && ev2.target.checked && form.everyone.checked) { form.everyone.checked = false; sync(); }
      });
      ['allday', 'repeat', 'everyone', 'rotate'].forEach((n) => form[n].addEventListener('change', sync));
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = async () => {
        const series = ev.repeat && ev.repeat !== 'none';
        if (!(await confirmDialog({ title: `Delete “${ev.title}”?`, body: series ? 'This deletes every repeat of it.' : 'This event will be removed.' }))) { eventModal(ev); return; }
        const copy = { ...ev };
        store.remove('events', ev.id);
        toastUndo(`${copy.title} deleted`, () => store.put('events', copy.id, copy));
      };
      form.onsubmit = (submitEvent) => {
        submitEvent.preventDefault();
        const err = form.querySelector('.form-error');
        const fail = (m, f) => { err.textContent = m; err.hidden = false; f?.focus(); };
        if (!form.title.value.trim()) return fail('Give it a name.', form.title);
        if (!form.date.value) return fail('Pick a date.', form.date);
        const repeat = form.repeat.value;
        const timed = !form.allday.checked;
        if (timed && form.end.value && form.end.value <= form.start.value) return fail('The end time should be after the start.', form.end);
        const who = [...form.querySelectorAll('input[name=who]:checked')].map((i) => i.value);
        if (!form.everyone.checked && !who.length && !(form.rotate.checked && repeat !== 'none')) return fail('Pick who it is for, or choose Everyone.');
        let rotation = null;
        if (repeat !== 'none' && form.rotate.checked) {
          const turns = [...form.querySelectorAll('input[name=turn]:checked')].map((i) => i.value);
          if (turns.length < 2) return fail('Pick at least two people to take turns.');
          const first = turns.includes(form.first.value) ? form.first.value : turns[0];
          const idx = turns.indexOf(first);
          rotation = { order: [...turns.slice(idx), ...turns.slice(0, idx)], by: form.by.value };
        }
        const weekdays = repeat === 'weekly' ? [...form.querySelectorAll('input[name=wd]:checked')].map((i) => Number(i.value)) : [];
        const data = {
          calendarId: form.calendarId.value, title: form.title.value.trim(), date: form.date.value,
          endDate: repeat === 'none' && form.endDate.value > form.date.value ? form.endDate.value : '',
          start: timed ? form.start.value : '', end: timed ? form.end.value : '',
          assignees: form.everyone.checked || rotation ? [] : who, repeat, every: repeat === 'none' ? 1 : Number(form.every.value) || 1,
          weekdays, until: repeat === 'none' ? '' : form.until.value, rotation, notes: form.notes.value.trim(),
          overrides: ev?.overrides || {}, exceptions: ev?.exceptions || {}, done: ev?.done || {},
        };
        if (editing) store.update('events', ev.id, data);
        else store.add('events', { ...data, createdBy: myId(), createdAt: Date.now() });
        closeModal();
        toast(editing ? 'Saved' : 'Event added');
        ui.selected = data.date;
        ui.month = data.date.slice(0, 7);
        draw();
      };
    }

    // ----- tasks -----

    function taskModal(task, prefill = {}) {
      const editing = !!task;
      const t = task || { title: '', notes: '', due: prefill.due || '', assignee: myId() };
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? 'Edit task' : 'New task'}</h2>
          <label class="field"><span>Task</span><input class="input" name="title" maxlength="80" value="${esc(t.title)}" ${editing ? '' : 'autofocus'}></label>
          <label class="field"><span>Notes <span class="muted">(optional)</span></span><textarea class="input" name="notes" rows="2" maxlength="300">${esc(t.notes || '')}</textarea></label>
          <div class="field-row">
            <label class="field grow"><span>For</span><select class="input" name="assignee">
              ${roster().map((p) => `<option value="${esc(p.id)}" ${t.assignee === p.id ? 'selected' : ''}>${esc(p.name)}${p.id === myId() ? ' (me)' : ''}</option>`).join('')}
              <option value="" ${t.assignee === '' ? 'selected' : ''}>Anyone</option></select></label>
            <label class="field grow"><span>Due <span class="muted">(optional)</span></span><input class="input" type="date" name="due" value="${esc(t.due || '')}"></label>
          </div>
          <p class="form-error" hidden></p>
          <div class="form-actions">
            ${editing ? '<button type="button" class="btn danger" data-m="delete">Delete</button>' : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = async () => {
        if (!(await confirmDialog({ title: `Delete “${task.title}”?`, body: 'This task will be removed.' }))) { taskModal(task); return; }
        const copy = { ...task };
        store.remove('tasks', task.id);
        toastUndo('Task deleted', () => store.put('tasks', copy.id, copy));
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        if (!form.title.value.trim()) { const err = form.querySelector('.form-error'); err.textContent = 'What needs doing?'; err.hidden = false; return; }
        const base = { title: form.title.value.trim(), notes: form.notes.value.trim(), due: form.due.value };
        if (editing) {
          if (form.assignee.value !== (task.assignee || '')) assignTask(task, form.assignee.value, base);
          else store.update('tasks', task.id, base);
        } else createTask(base.title, form.assignee.value, base);
        closeModal();
        toast('Saved');
      };
    }

    // ----- notes -----

    function noteModal(note, type = 'memo') {
      const editing = !!note;
      const n = note || { type, title: '', body: '', items: [], pinned: false, calendarId: '' };
      const dlg = openModal(`
        <form class="form" novalidate>
          <h2>${editing ? (n.type === 'list' ? 'Edit list' : 'Edit memo') : (n.type === 'list' ? 'New list' : 'New memo')}</h2>
          <label class="field"><span>Title</span><input class="input" name="title" maxlength="50" value="${esc(n.title)}" placeholder="${n.type === 'list' ? 'e.g. Groceries' : 'e.g. Wi-Fi & door codes'}" ${editing ? '' : 'autofocus'}></label>
          ${n.type === 'memo' ? `<label class="field"><span>Memo</span><textarea class="input" name="body" rows="6" maxlength="2000">${esc(n.body || '')}</textarea></label>` : '<p class="muted small">Add and tick off items right on the list.</p>'}
          <label class="field"><span>Belongs to <span class="muted">(optional)</span></span><select class="input" name="calendarId"><option value="">Everyone</option>${calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === n.calendarId ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('')}</select></label>
          <div class="form-actions">
            ${editing ? '<button type="button" class="btn danger" data-m="delete">Delete</button>' : ''}
            <span class="spacer"></span>
            <button type="button" class="btn" data-m="cancel">Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`);
      const form = dlg.querySelector('form');
      form.querySelector('[data-m=cancel]').onclick = closeModal;
      const del = form.querySelector('[data-m=delete]');
      if (del) del.onclick = async () => {
        if (!(await confirmDialog({ title: `Delete “${note.title || 'this note'}”?`, body: 'It will be removed for everyone.' }))) { noteModal(note); return; }
        const copy = { ...note };
        store.remove('notes', note.id);
        toastUndo('Note deleted', () => store.put('notes', copy.id, copy));
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const data = { type: n.type, title: form.title.value.trim(), body: n.type === 'memo' ? form.body.value : '', items: n.items || [], pinned: !!n.pinned, calendarId: form.calendarId.value, updatedAt: Date.now() };
        if (!data.title && !data.body && !(data.items || []).length) { toast('Add a title first'); return; }
        if (editing) store.update('notes', note.id, data);
        else store.add('notes', { ...data, createdBy: myId() });
        closeModal();
      };
    }

    // ----- bills -----

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

    // =====================================================================
    // Actions
    // =====================================================================

    root.addEventListener('dblclick', (e) => {
      const cell = e.target.closest('.cal-day[data-date]');
      if (cell) { ui.selected = cell.dataset.date; eventModal(null, { date: cell.dataset.date }); }
    });

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const id = b.dataset.id;
      const date = b.dataset.date;
      switch (b.dataset.action) {
        case 'tab': ui.tab = b.dataset.tab; break;
        case 'money-tab': ui.money = b.dataset.tab; break;
        case 'prev-month': ui.month = addMonths(ui.month, -1); break;
        case 'next-month': ui.month = addMonths(ui.month, 1); break;
        case 'today': ui.month = monthKey(new Date()); ui.selected = todayISO(); break;
        case 'pick-day': ui.selected = date; break;
        case 'toggle-cal': {
          const h = hiddenSet();
          if (h.has(id)) h.delete(id); else h.add(id);
          setPref('calHidden', JSON.stringify([...h]));
          break;
        }
        case 'mine-only': ui.mineOnly = !ui.mineOnly; setPref('calMine', ui.mineOnly ? '1' : '0'); break;
        case 'manage-cals': return manageCalsModal();
        case 'new-cal': return calModal(null, TEMPLATES[Number(b.dataset.template)]);
        case 'set-status': return statusModal(date || todayISO());
        case 'add-event': return eventModal(null, { date });
        case 'edit-event': return eventModal(events.find((x) => x.id === id), { occ: date });
        case 'add-task-on': return taskModal(null, { due: date });
        case 'toggle-done': {
          const ev = events.find((x) => x.id === id);
          if (!ev) return;
          store.update('events', id, { done: { ...(ev.done || {}), [date]: !ev.done?.[date] } });
          return;
        }
        case 'swap-turn': {
          const ev = events.find((x) => x.id === id);
          if (!ev?.rotation?.order?.length) return;
          const order = ev.rotation.order;
          const now = assigneesFor(ev, date, dayEvents([ev], calendars, date)[0]?.index || 0)[0];
          const next = order[(order.indexOf(now) + 1) % order.length];
          const prevOverrides = ev.overrides || {};
          store.update('events', id, { overrides: { ...prevOverrides, [date]: { assignees: [next] } } });
          toastUndo(`${personById(next).name} takes it`, () => store.update('events', id, { overrides: prevOverrides }));
          return;
        }
        case 'add-task': {
          const title = ui.quickTask.trim();
          if (!title) { toast('What needs doing?'); root.querySelector('[data-quick-task]')?.focus(); return; }
          const assignee = ui.quickAssignee === 'me' ? myId() : ui.quickAssignee;
          const tid = createTask(title, assignee);
          ui.quickTask = '';
          const who = assignee && assignee !== myId() ? personById(assignee).name : '';
          draw();
          toastUndo(who ? `Sent to ${who}` : 'Task added', () => store.remove('tasks', tid));
          return;
        }
        case 'toggle-task': {
          const t = tasks.find((x) => x.id === id);
          if (!t) return;
          if (t.status === 'done') { store.update('tasks', id, { status: t.assignee ? 'accepted' : 'open', doneAt: 0, doneBy: '' }); return; }
          const prev = { status: t.status, doneAt: 0, doneBy: '' };
          store.update('tasks', id, { status: 'done', doneAt: Date.now(), doneBy: myId() });
          toastUndo('Task done', () => store.update('tasks', id, prev));
          return;
        }
        case 'edit-task': return taskModal(tasks.find((x) => x.id === id));
        case 'accept-task': acceptTask(id); toast('Accepted. It is on your day.'); return;
        case 'decline-task': {
          const t = tasks.find((x) => x.id === id);
          if (!t) return;
          declineTask(t);
          toast('Passed back');
          return;
        }
        case 'give-task': {
          const t = tasks.find((x) => x.id === id);
          if (!t) return;
          const to = b.dataset.to;
          const prev = assignTask(t, to);
          toastUndo(to === myId() ? 'Taken' : `Sent to ${personById(to).name}`, () => store.update('tasks', id, prev));
          return;
        }
        case 'new-note': return noteModal(null, b.dataset.type);
        case 'edit-note': return noteModal(notes.find((x) => x.id === id));
        case 'pin-note': { const n = notes.find((x) => x.id === id); if (n) store.update('notes', id, { pinned: !n.pinned }); return; }
        case 'del-item': {
          const n = notes.find((x) => x.id === b.dataset.note);
          if (!n) return;
          const prev = n.items || [];
          store.update('notes', n.id, { items: prev.filter((i) => i.id !== b.dataset.item), updatedAt: Date.now() });
          toastUndo('Item removed', () => store.update('notes', n.id, { items: prev }));
          return;
        }
        case 'clear-done': {
          const n = notes.find((x) => x.id === id);
          if (!n) return;
          const prev = n.items || [];
          store.update('notes', id, { items: prev.filter((i) => !i.done), updatedAt: Date.now() });
          toastUndo('Checked items cleared', () => store.update('notes', id, { items: prev }));
          return;
        }
        case 'free-person': {
          const set = new Set(ui.freeCustom ? ui.freePeople || [] : roster().map((p) => p.id));
          if (set.has(id)) set.delete(id); else set.add(id);
          ui.freePeople = [...set];
          ui.freeCustom = true;
          break;
        }
        case 'free-prev': ui.freeWeek = Math.max(0, ui.freeWeek - 1); break;
        case 'free-next': ui.freeWeek += 1; break;
        case 'plan-free': {
          const date2 = b.dataset.date, start = b.dataset.start, end = b.dataset.end;
          const startMin = toMin(start);
          const isDate = b.dataset.label === 'date';
          const planStart = isDate ? fromMin(Math.max(startMin, 19 * 60)) : start;
          const planEnd = isDate ? fromMin(Math.min(toMin(end), toMin(planStart) + 180)) : end;
          return eventModal(null, { date: date2, start: planStart, end: planEnd, title: isDate ? 'Date night' : '' });
        }
        case 'add-bill': return billModal(null);
        case 'edit-bill': return billModal(bills.find((x) => x.id === id));
        case 'add-from-sub': {
          const s = subs.find((x) => x.id === id);
          if (!s) return;
          const yearly = s.frequency === 'yearly';
          return billModal(null, { name: s.name, amount: s.amount, freq: yearly ? 'yearly' : 'monthly', day: Number((s.lastDate || '').slice(8, 10)) || '', startDate: yearly ? s.lastDate : '', match: s.key, autopay: false });
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
        case 'ignore-sub': store.update('subscriptions', id, { ignored: true }); toastUndo('Hidden from the tracker', () => store.update('subscriptions', id, { ignored: false })); return;
        case 'restore-sub': store.update('subscriptions', id, { ignored: false }); return;
        default: return;
      }
      draw();
    });

    root.addEventListener('input', (e) => {
      if (e.target.dataset.quickTask !== undefined) ui.quickTask = e.target.value;
    });

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.quickAssignee !== undefined) { ui.quickAssignee = t.value; return; }
      if (t.dataset.free) { ui[t.dataset.free] = t.value; draw(); return; }
      if (t.dataset.listItem) {
        const n = notes.find((x) => x.id === t.dataset.note);
        if (n) store.update('notes', n.id, { items: (n.items || []).map((i) => (i.id === t.dataset.listItem ? { ...i, done: t.checked } : i)), updatedAt: Date.now() });
      }
    });

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (t.dataset.quickTask !== undefined) { e.preventDefault(); root.querySelector('[data-action=add-task]').click(); }
      if (t.dataset.addItem) {
        e.preventDefault();
        const text = t.value.trim();
        const n = notes.find((x) => x.id === t.dataset.addItem);
        if (!text || !n) return;
        store.update('notes', n.id, { items: [...(n.items || []), { id: Math.random().toString(36).slice(2, 10), text, done: false }], updatedAt: Date.now() });
        t.value = '';
      }
    });

    const unsubs = [
      store.subscribe('bills', (l) => { bills = l; draw(); }),
      store.subscribe('subscriptions', (l) => { subs = l; draw(); }),
      store.subscribe('categories', (l) => { cats = l; }),
      store.subscribe('settings', (l) => { settings = Object.fromEntries(l.map((d) => [d.id, d])); draw(); }),
      store.subscribe('calendars', (l) => { calendars = [...l].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)); draw(); }),
      store.subscribe('events', (l) => { events = l; draw(); }),
      store.subscribe('tasks', (l) => { tasks = l; draw(); }),
      store.subscribe('notes', (l) => { notes = l; draw(); }),
      store.subscribe('statuses', (l) => { statuses = l; draw(); }),
      subscribePeople(() => draw()),
      subscribeRecent((l) => { txs = l; draw(); }),
    ];

    draw();
    return () => { clearInterval(tick); topBtn.remove(); unsubs.forEach((u) => u()); };
  },
};

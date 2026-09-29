// Scheduling logic for the calendar: repeating events, "your turn / my turn" rotation, who an item is for,
// and finding shared free time. Pure functions (no DOM, no storage). Mirrored in sync/insights.py for the
// morning summary, so keep the two in step.
//
// event: {
//   calendarId, title, date 'YYYY-MM-DD', endDate?, start 'HH:MM' | '' (all day), end 'HH:MM',
//   assignees: [uid] (empty = everyone in the calendar), notes,
//   repeat: 'none'|'daily'|'weekly'|'monthly'|'yearly', every (interval, default 1), weekdays: [0..6] (Sunday = 0), until?,
//   rotation: { order: [uid, ...], by: 'time' | 'week' }   // take turns: who's up switches each time (or each week)
//   overrides: { 'YYYY-MM-DD': { assignees: [uid] } },     // swap one occurrence
//   exceptions: { 'YYYY-MM-DD': true },                    // skip one occurrence
//   done: { 'YYYY-MM-DD': true }
// }
import { addDaysISO, daysBetweenISO } from './stats.js';

const parse = (iso) => new Date(`${iso}T12:00:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dow = (isoDate) => parse(isoDate).getDay();
export const mondayOf = (isoDate) => addDaysISO(isoDate, -((dow(isoDate) + 6) % 7));

export const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
export const fmtTime = (hhmm) => (hhmm ? new Date(2000, 0, 1, ...hhmm.split(':').map(Number)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Every occurrence of `ev` between `from` and `to` (inclusive) as [{ date, index }]. `index` counts occurrences since the
// first one, which rotation uses. Repeating events are stored once and expanded here.
export function eventOccurrences(ev, from, to) {
  const out = [];
  const start = ev.date;
  if (!start || to < start) return out;
  const until = ev.until || '9999-12-31';
  const last = to < until ? to : until;
  const every = Math.max(1, Number(ev.every) || 1);
  const skip = (d) => ev.exceptions && ev.exceptions[d];
  const push = (d, index) => { if (d >= from && d <= last && !skip(d)) out.push({ date: d, index }); };
  const repeat = ev.repeat || 'none';

  if (repeat === 'none') {
    const end = ev.endDate && ev.endDate > start ? ev.endDate : start;
    for (let d = start < from ? from : start, n = 0; d <= end && d <= to; d = addDaysISO(d, 1), n++) if (!skip(d)) out.push({ date: d, index: 0 });
    return out;
  }
  if (repeat === 'daily') {
    for (let d = start, i = 0; d <= last; d = addDaysISO(d, every), i++) push(d, i);
  } else if (repeat === 'weekly') {
    const days = ev.weekdays && ev.weekdays.length ? ev.weekdays : [dow(start)];
    const startMonday = mondayOf(start);
    let index = 0;
    for (let d = start; d <= last && index < 5000; d = addDaysISO(d, 1)) {
      if (!days.includes(dow(d))) continue;
      const weeks = Math.round(daysBetweenISO(startMonday, mondayOf(d)) / 7);
      if (weeks % every !== 0) continue;
      push(d, index);
      index++;
    }
  } else if (repeat === 'monthly' || repeat === 'yearly') {
    const s = parse(start);
    const step = repeat === 'monthly' ? every : 12 * every;
    for (let i = 0; i < 1200; i++) {
      const total = s.getMonth() + i * step;
      const y = s.getFullYear() + Math.floor(total / 12), m = ((total % 12) + 12) % 12;
      const d = iso(new Date(y, m, Math.min(s.getDate(), daysInMonth(y, m))));
      if (d > last) break;
      push(d, i);
    }
  }
  return out;
}

// Who is this occurrence for? Swapped one-offs win, then the rotation, then the fixed assignees.
export function assigneesFor(ev, date, index = 0) {
  const swap = ev.overrides && ev.overrides[date];
  if (swap && swap.assignees) return swap.assignees;
  const r = ev.rotation;
  if (r && r.order && r.order.length) {
    const n = r.order.length;
    const i = r.by === 'week' ? Math.floor(daysBetweenISO(mondayOf(ev.date), mondayOf(date)) / 7) : index;
    return [r.order[((i % n) + n) % n]];
  }
  return ev.assignees || [];
}

// Is this person involved? An item with named assignees is for them; otherwise for everyone in its calendar.
export function involves(assignees, calendar, uid) {
  if (assignees.length) return assignees.includes(uid);
  return !calendar || !calendar.members || !calendar.members.length || calendar.members.includes(uid);
}

// Everything happening on one day: [{ ev, date, index, assignees, cal }], all-day first, then by time.
export function dayEvents(events, calendars, date) {
  const cals = new Map(calendars.map((c) => [c.id, c]));
  const out = [];
  for (const ev of events) {
    for (const o of eventOccurrences(ev, date, date)) {
      out.push({ ev, date, index: o.index, assignees: assigneesFor(ev, date, o.index), cal: cals.get(ev.calendarId) });
    }
  }
  return out.sort((a, b) => (a.ev.start ? 1 : 0) - (b.ev.start ? 1 : 0) || toMin(a.ev.start) - toMin(b.ev.start) || (a.ev.title || '').localeCompare(b.ev.title || ''));
}

// ---------- shared free time ----------

// Gaps when NONE of `uids` is busy on `date`. Only timed events block time. Each gap is labelled a "date night" when it
// covers a decent stretch of the evening, otherwise plain joint free time.
export function freeWindows(events, calendars, uids, date, { from = '08:00', to = '22:00', min = 60 } = {}) {
  const lo = toMin(from), hi = toMin(to);
  const busy = [];
  for (const it of dayEvents(events, calendars, date)) {
    if (!it.ev.start) continue;
    if (!uids.some((u) => involves(it.assignees, it.cal, u))) continue;
    const s = toMin(it.ev.start);
    busy.push([s, Math.max(it.ev.end ? toMin(it.ev.end) : s + 60, s + 15)]);
  }
  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of busy) {
    if (merged.length && b[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b[1]);
    else merged.push([...b]);
  }
  const gaps = [];
  let cursor = lo;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, Math.min(s, hi)]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < hi) gaps.push([cursor, hi]);
  return gaps.filter(([s, e]) => e - s >= min && e > s).map(([s, e]) => {
    const evening = Math.max(0, Math.min(e, 22 * 60) - Math.max(s, 17 * 60 + 30));   // minutes between 5:30 and 10 pm
    return { start: fromMin(s), end: fromMin(e), minutes: e - s, label: evening >= 120 ? 'date' : 'free' };
  });
}

// Demo ("sandbox") data: a complete, made-up household for showing the app off. Everything here is fictional:
// invented merchants, accounts and people. Generated relative to today so months and countdowns always look current.
// A fixed random seed keeps the demo looking the same every time.

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const r2 = (n) => Math.round(n * 100) / 100;

const WEDDING_COSTS = [
  ['Venue', '🏛️', 20], ['Catering & bar', '🍽️', 25], ['Photography & video', '📸', 10], ['Attire & alterations', '👗', 8],
  ['Flowers & decor', '💐', 8], ['Music / DJ', '🎶', 7], ['Rings', '💍', 3], ['Cake & desserts', '🎂', 2],
  ['Invitations & stationery', '💌', 2], ['Hair & makeup', '💄', 2], ['Officiant & license', '📜', 1],
  ['Transportation', '🚗', 2], ['Favors & gifts', '🎁', 1], ['Honeymoon', '🏝️', 5], ['Contingency (unexpected)', '🧾', 4],
];

export function generateDemo(todayISO) {
  const rnd = mulberry32(20260929);
  const between = (a, b) => r2(a + rnd() * (b - a));
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const now = new Date(`${todayISO}T12:00:00`);
  const stamp = Date.now();
  const data = { categories: {}, transactions: {}, accounts: {}, goals: {}, contributions: {}, settings: {}, weddingItems: {}, bankSync: {}, bills: {}, subscriptions: {}, notifications: {}, people: {}, calendars: {}, events: {}, tasks: {}, notes: {}, statuses: {}, outbox: {} };
  const put = (coll, id, doc) => { data[coll][id] = { ...doc, id, updatedAt: stamp }; };

  // ---- categories (with monthly budgets) ----
  const CATS = [
    ['inc_pay', 'Paycheck', '💵', 'income', 0], ['inc_other', 'Other income', '🎁', 'income', 0],
    ['mortgage', 'Mortgage / Rent', '🏠', 'expense', 1850], ['utilities', 'Utilities', '💡', 'expense', 310],
    ['groceries', 'Groceries', '🛒', 'expense', 650], ['dining', 'Dining out', '🍔', 'expense', 260],
    ['transport', 'Transportation', '🚗', 'expense', 300], ['insurance', 'Insurance', '🛡️', 'expense', 240],
    ['home', 'Home maintenance', '🔧', 'expense', 150], ['health', 'Health', '💊', 'expense', 120],
    ['subs', 'Subscriptions', '📺', 'expense', 60], ['fun', 'Entertainment', '🎬', 'expense', 180],
    ['shopping', 'Shopping', '🛍️', 'expense', 620], ['other', 'Other', '📦', 'expense', 200],
  ];
  CATS.forEach(([id, name, icon, type, budget], order) => put('categories', id, { name, icon, type, budget, order, archived: false }));

  // ---- transactions: six months up to today ----
  const CHECKING = 'Everyday Checking ••1234', CARD = 'Rewards Card ••5678';
  let n = 0;
  const add = (date, cat, amount, note, account = CARD, extra = {}) => {
    const type = cat.startsWith('inc_') ? 'income' : 'expense';
    put('transactions', `demo${n++}`, { date, type, amount: r2(amount), categoryId: cat, note, account, source: 'bank', ...extra });
  };
  for (let k = 5; k >= 0; k--) {
    const d0 = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const y = d0.getFullYear(), m = d0.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const maxDay = k === 0 ? now.getDate() : last;
    const day = (d) => (d <= maxDay ? `${y}-${pad(m + 1)}-${pad(d)}` : null);
    const on = (d, fn) => { const s = day(d); if (s) fn(s); };
    const spread = () => day(1 + Math.floor(rnd() * maxDay));

    on(1, (s) => add(s, 'inc_pay', 2650, 'Acme Payroll', CHECKING));
    on(15, (s) => add(s, 'inc_pay', 2650, 'Acme Payroll', CHECKING));
    if (k % 2 === 0) on(20, (s) => add(s, 'inc_other', between(60, 180), 'Marketplace sale', CHECKING));
    on(2, (s) => add(s, 'mortgage', 1850, 'Maple Mortgage Co.', CHECKING));
    on(8, (s) => add(s, 'insurance', 238, 'Shield Insurance', CHECKING));
    on(10, (s) => add(s, 'utilities', between(92, 138), 'City Power & Light'));
    on(18, (s) => add(s, 'utilities', between(48, 70), 'Aqua Water Utility'));
    on(4, (s) => add(s, 'utilities', 79.99, 'NetStream Internet'));
    on(5, (s) => add(s, 'subs', 15.49, 'StreamFlix'));
    on(9, (s) => add(s, 'subs', 10.99, 'TuneBox'));
    on(12, (s) => add(s, 'subs', 2.99, 'CloudDrive'));
    on(11, (s) => add(s, 'subs', k === 0 ? 12.99 : 9.99, 'NewsToday Digital'));
    on(16, (s) => add(s, 'groceries', between(228, 262), 'Bulk Warehouse'));
    for (let i = 0; i < 6; i++) { const s = spread(); if (s) add(s, 'groceries', between(24, 96), pick(['Fresh Market', 'Corner Grocer', 'Green Basket'])); }
    for (let i = 0; i < 7; i++) { const s = spread(); if (s) add(s, 'dining', between(11, 46), pick(['Sunrise Café', 'Taco Corner', "Luigi's Kitchen", 'Noodle House'])); }
    for (let i = 0; i < 4; i++) { const s = spread(); if (s) add(s, 'transport', between(34, 52), 'Gas-N-Go'); }
    on(3, (s) => add(s, 'transport', 27, 'Metro Transit'));
    for (let i = 0; i < 4; i++) { const s = spread(); if (s) add(s, 'shopping', between(18, 92), pick(['Home Goods Depot', 'Bookish', 'Style Outlet'])); }
    if (rnd() > 0.4) { const s = spread(); if (s) add(s, 'health', between(14, 44), 'Green Cross Pharmacy'); }
    if (rnd() > 0.5) { const s = spread(); if (s) add(s, 'home', between(20, 88), 'Hardware Hub'); }
    for (let i = 0; i < 2; i++) { const s = spread(); if (s) add(s, 'fun', between(22, 58), pick(['Cinema Palace', 'Fun Zone Arcade', 'Riverside Concerts'])); }
  }

  // Make the current month interesting: dining over budget, groceries close, one big purchase, a few to review.
  const thisMonth = todayISO.slice(0, 7);
  const monthSum = (cat) => Object.values(data.transactions).filter((t) => t.categoryId === cat && t.date.startsWith(thisMonth)).reduce((s, t) => s + t.amount, 0);
  const shift = (days) => { const d = new Date(now); d.setDate(d.getDate() - days); return isoOf(d); };
  const top = (cat, target, note) => { const gap = target - monthSum(cat); if (gap > 8) add(shift(1), cat, gap, note); };
  top('dining', 274, "Luigi's Kitchen");
  top('groceries', 560, 'Fresh Market');
  add(shift(1), 'shopping', 349.99, 'TechMart');
  add(shift(0), 'other', 42.5, 'Blue Door Boutique', CARD, { needsReview: true });
  add(shift(1), 'other', 18.75, 'Sunny Side Market', CARD, { needsReview: true });
  add(shift(2), 'other', 63.2, 'Pinecone Supply Co.', CARD, { needsReview: true });

  // ---- accounts and sync status ----
  put('accounts', 'acct1', { name: CHECKING, org: 'Demo Bank', balance: 4218.36, balanceDate: stamp, source: 'demo' });
  put('accounts', 'acct2', { name: CARD, org: 'Demo Bank', balance: -1246.8, balanceDate: stamp, source: 'demo' });
  put('accounts', 'acct3', { name: 'High-Yield Savings ••9012', org: 'Demo Bank', balance: 9640.12, balanceDate: stamp, source: 'demo' });
  put('bankSync', 'status', { lastRun: stamp - 2 * 3600e3, ok: true, errors: [] });

  // ---- goals and their history ----
  const monthsAgo = (k, d) => isoOf(new Date(now.getFullYear(), now.getMonth() - k, d));
  const ahead = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); return isoOf(d); };
  put('goals', 'goal1', { name: 'Emergency fund', icon: '🛟', type: 'emergency', target: 12000, startAmount: 3000, deadline: ahead(420), monthly: 0, apr: 0, createdDate: monthsAgo(5, 1), archived: false, order: 0 });
  put('goals', 'goal2', { name: 'Family vacation', icon: '✈️', type: 'savings', target: 3200, startAmount: 0, deadline: '', monthly: 200, apr: 0, createdDate: monthsAgo(4, 1), archived: false, order: 1 });
  put('goals', 'goal3', { name: 'Pay off rewards card', icon: '💳', type: 'debt', target: 4800, startAmount: 900, deadline: ahead(365), monthly: 0, apr: 21.9, createdDate: monthsAgo(4, 1), archived: false, order: 2 });
  let c = 0;
  const contrib = (goalId, date, amount, note = '') => put('contributions', `dc${c++}`, { goalId, date, amount, note });
  for (let k = 5; k >= 1; k--) contrib('goal1', monthsAgo(k, 10), 400);
  contrib('goal1', monthsAgo(0, 3) <= todayISO ? monthsAgo(0, 3) : monthsAgo(1, 28), 400);
  for (let k = 4; k >= 1; k--) contrib('goal2', monthsAgo(k, 12), k === 2 ? 150 : 200);
  for (let k = 4; k >= 1; k--) contrib('goal3', monthsAgo(k, 20), 250);

  // ---- wedding ----
  const weddingBudget = 28000;
  put('settings', 'wedding', { date: ahead(300), guests: 120, budget: weddingBudget });
  WEDDING_COSTS.forEach(([name, icon, share], order) => {
    const paid = name === 'Venue' ? 4000 : name === 'Photography & video' ? 1000 : 0;
    put('weddingItems', `wi${order}`, {
      name, icon, estimate: Math.round(weddingBudget * share / 100), paid, order,
      vendor: name === 'Venue' ? 'Willow Creek Barn' : name === 'Photography & video' ? 'Golden Hour Studio' : '',
      dueDate: '', note: '',
    });
  });
  for (let k = 5; k >= 1; k--) contrib('wedding', monthsAgo(k, 5), 1300, k === 5 ? 'Started the fund' : '');
  contrib('wedding', monthsAgo(3, 8), -4000, 'Paid Venue');
  contrib('wedding', monthsAgo(2, 8), -1000, 'Paid Photography & video');

  // ---- bills (a mix of autopay and manual) ----
  const dayOf = (d) => Math.min(d, 28);
  const bill = (id, name, amount, day, autopay, match, extra = {}) =>
    put('bills', id, { name, amount, freq: 'monthly', day: dayOf(day), startDate: '', autopay, remindDays: 3, categoryId: '', match, paid: {}, active: true, ...extra });
  bill('bill1', 'Mortgage', 1850, 2, true, 'maple mortgage');
  bill('bill2', 'Home insurance', 238, 8, true, 'shield insurance');
  bill('bill3', 'Electric', 115, 10, false, 'city power');
  bill('bill4', 'Water', 58, 18, false, 'aqua water');
  bill('bill5', 'Internet', 79.99, Math.max(1, now.getDate() + 3 > 28 ? 5 : now.getDate() + 3), false, 'netstream');   // due in a few days: shows a reminder
  bill('bill6', 'Car payment', 342.18, 24, true, 'autoloan');
  bill('bill7', 'Trash service', 96, 1, false, 'green trash', { freq: 'yearly', day: 0, startDate: ahead(75) });

  // ---- subscriptions the tracker "found" (one price just went up) ----
  const sub = (id, key, name, amount, previous, changedOn, extra = {}) =>
    put('subscriptions', id, { key, name, frequency: 'monthly', amount, previous, changedOn, lastDate: shift(3), nextDate: ahead(27), count: 6, monthly: amount, active: true, ignored: false,
      runs: previous == null ? [{ amount, since: monthsAgo(5, 5) }] : [{ amount: previous, since: monthsAgo(5, 5) }, { amount, since: changedOn }], ...extra });
  sub('sub1', 'streamflix', 'StreamFlix', 15.49, 13.99, monthsAgo(3, 5));
  sub('sub2', 'tunebox', 'TuneBox', 10.99, null, '');
  sub('sub3', 'clouddrive', 'CloudDrive', 2.99, null, '');
  sub('sub4', 'newstoday digital', 'NewsToday Digital', 12.99, 9.99, shift(9), { lastDate: shift(9) });
  sub('sub5', 'shield insurance', 'Shield Insurance', 238, 224, monthsAgo(4, 8), { lastDate: monthsAgo(0, 8) <= todayISO ? monthsAgo(0, 8) : monthsAgo(1, 8) });
  sub('sub6', 'maple mortgage', 'Maple Mortgage Co.', 1850, null, '', { lastDate: monthsAgo(0, 2) <= todayISO ? monthsAgo(0, 2) : monthsAgo(1, 2) });

  // ---- notification history (what the bell shows) ----
  const note = (id, kind, title, body, hoursAgo, link = '#/budget') =>
    put('notifications', id, { kind, title, body, link, quiet: false, ts: stamp - hoursAgo * 3600e3 });
  note('n1', 'price', 'NewsToday Digital went up', 'From $9.99 to $12.99 a month', 5, '#/calendar');
  note('n4', 'bill', 'Internet is due soon', 'Internet bill of $79.99 is coming up', 30, '#/calendar');
  note('n5', 'weekly', 'Your week: $412.60 spent', '▼ 8% vs last week. Top: Groceries $168. Biggest: Bulk Warehouse $241', 52, '#/home');

  // ---- people, calendars, events, tasks, notes ----
  const ME = 'demo-me', SAM = 'demo-partner';
  put('people', ME, { name: 'Alex', color: '#4f7396', createdAt: 1, digest: true });
  put('people', SAM, { name: 'Sam', color: '#0f7f5f', createdAt: 2, digest: true });
  put('calendars', 'cal_family', { name: 'Family', icon: '🏠', color: '#4f7396', members: [], hideFromDigest: false, order: 0 });
  put('calendars', 'cal_couple', { name: 'Couple', icon: '💞', color: '#a4576b', members: [ME, SAM], hideFromDigest: false, order: 1 });
  put('calendars', 'cal_work', { name: 'Alex – work', icon: '💼', color: '#5f7280', members: [ME], hideFromDigest: true, order: 2 });
  put('calendars', 'cal_work2', { name: 'Sam – work', icon: '💼', color: '#b58a2a', members: [SAM], hideFromDigest: true, order: 3 });
  put('calendars', 'cal_hobby', { name: 'Pottery club', icon: '🏺', color: '#6a5bb5', members: [ME], hideFromDigest: false, order: 4 });

  const dowNow = (now.getDay() + 6) % 7;                       // Monday = 0
  const monday = (() => { const d = new Date(now); d.setDate(d.getDate() - dowNow); return isoOf(d); })();
  const on = (offset) => { const d = new Date(now); d.setDate(d.getDate() + offset); return isoOf(d); };
  const ev = (id, calendarId, title, date, extra = {}) => put('events', id, {
    calendarId, title, date, endDate: '', start: '', end: '', assignees: [], repeat: 'none', every: 1, weekdays: [], until: '', rotation: null, notes: '',
    overrides: {}, exceptions: {}, done: {}, createdBy: ME, ...extra,
  });
  ev('e_trash', 'cal_family', 'Take out the trash', monday, { start: '19:00', end: '19:15', repeat: 'weekly', weekdays: [2], rotation: { order: [ME, SAM], by: 'time' } });
  ev('e_dishes', 'cal_family', 'Do the dishes', monday, { start: '20:00', end: '20:30', repeat: 'daily', rotation: { order: [SAM, ME], by: 'week' } });
  ev('e_commute', 'cal_family', 'Drive the morning commute', monday, { start: '07:30', end: '08:15', repeat: 'weekly', weekdays: [1, 2, 3, 4, 5], rotation: { order: [ME, SAM], by: 'week' } });
  ev('e_work1', 'cal_work', 'Shift', monday, { start: '09:00', end: '17:00', repeat: 'weekly', weekdays: [1, 2, 3, 4, 5], assignees: [ME] });
  ev('e_work2', 'cal_work2', 'Shift', monday, { start: '11:00', end: '19:30', repeat: 'weekly', weekdays: [2, 3, 4, 5, 6], assignees: [SAM] });
  ev('e_pottery', 'cal_hobby', 'Pottery class', monday, { start: '18:30', end: '20:30', repeat: 'weekly', weekdays: [4], assignees: [ME] });
  ev('e_date', 'cal_couple', "Dinner at Luigi's", on(((5 - now.getDay() + 7) % 7) || 7), { start: '19:30', end: '21:30' });
  ev('e_dentist', 'cal_family', 'Dentist', on(2), { start: '15:30', end: '16:30', assignees: [ME] });
  ev('e_bday', 'cal_family', "Sam's birthday 🎂", on(34), { repeat: 'yearly' });

  const task = (id, title, assignee, status, extra = {}) => put('tasks', id, {
    title, notes: '', due: '', assignee, assignedBy: '', status, createdBy: ME, createdAt: stamp - 3600e3, assignedAt: 0, ...extra,
  });
  task('t1', 'Pick up groceries', ME, 'pending', { assignedBy: SAM, assignedAt: stamp - 1800e3, due: todayISO, notes: 'Milk, eggs, sourdough' });
  task('t2', 'Call the plumber', ME, 'accepted', { assignedBy: ME });
  task('t3', 'Renew car registration', '', 'open', { due: on(10) });
  task('t4', 'Confirm the florist', SAM, 'pending', { assignedBy: ME, assignedAt: stamp - 7200e3, due: on(3) });
  task('t5', 'Order wedding invitations', ME, 'done', { assignedBy: ME, doneAt: stamp - 86400e3, doneBy: ME });

  const item = (id, text, done = false) => ({ id, text, done });
  put('notes', 'n_groc', { type: 'list', title: 'Groceries', body: '', pinned: true, calendarId: '', updatedAt: stamp - 600e3, items: [item('g1', 'Sourdough bread'), item('g2', 'Eggs'), item('g3', 'Oat milk', true), item('g4', 'Bananas'), item('g5', 'Dish soap')] });
  put('notes', 'n_wed', { type: 'list', title: 'Wedding to-do', body: '', pinned: false, calendarId: '', updatedAt: stamp - 7200e3, items: [item('w1', 'Book the cake tasting'), item('w2', 'Send save-the-dates', true), item('w3', 'Choose the DJ playlist')] });
  put('notes', 'n_house', { type: 'memo', title: 'House notes', body: 'Trash goes out Tuesday night.\nDishwasher: run the eco cycle.\nSpare key is with the neighbors.', pinned: false, calendarId: 'cal_family', updatedAt: stamp - 86400e3 * 3, items: [] });

  put('statuses', `${ME}_${todayISO}`, { uid: ME, date: todayISO, text: 'Working from home today', emoji: '🏠' });
  put('statuses', `${SAM}_${todayISO}`, { uid: SAM, date: todayISO, text: 'Out with friends tonight', emoji: '👥' });

  // ---- preferences ----
  put('settings', 'budget', { income: 5300, alertAt: 0.8, alertsOn: true, bigOn: true, bigAmount: 250, weeklyOn: true });
  return data;
}

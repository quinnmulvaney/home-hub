// Bank CSV import. Understands:
//   - Budgeting-app exports (Rocket Money style): Date, Account Name, Account Number, Name, Amount (+ = money out), Category
//   - Chase credit card downloads: Transaction Date, Description, Category, Type, Amount (− = purchase)
//   - Chase checking/savings downloads: Details, Posting Date, Description, Amount (− = debit), Type
// Every row gets a deterministic id, so importing the same file twice never duplicates anything.
import * as store from './store.js';
import { esc, money, openModal, closeModal, toast } from './util.js';

// Source category (lowercase) -> [app category, type, icon], or null = transfer between your own accounts (skipped).
const CATEGORY_MAP = {
  'shopping': ['Shopping', 'expense', '🛍️'],
  'groceries': ['Groceries', 'expense', '🛒'],
  'auto & transport': ['Transportation', 'expense', '🚗'],
  'automotive': ['Transportation', 'expense', '🚗'],
  'gas': ['Transportation', 'expense', '🚗'],
  'dining & drinks': ['Dining out', 'expense', '🍔'],
  'food & drink': ['Dining out', 'expense', '🍔'],
  'bills & utilities': ['Utilities', 'expense', '💡'],
  'entertainment & rec.': ['Entertainment', 'expense', '🎬'],
  'entertainment': ['Entertainment', 'expense', '🎬'],
  'home & garden': ['Home maintenance', 'expense', '🔧'],
  'home': ['Home maintenance', 'expense', '🔧'],
  'software & tech': ['Subscriptions', 'expense', '📺'],
  'health & wellness': ['Health', 'expense', '💊'],
  'medical': ['Health', 'expense', '💊'],
  'personal care': ['Personal care', 'expense', '💇'],
  'personal': ['Personal care', 'expense', '💇'],
  'loan payment': ['Loan payments', 'expense', '🏦'],
  'cash & checks': ['Cash & checks', 'expense', '💵'],
  'fees': ['Fees', 'expense', '💳'],
  'fees & adjustments': ['Fees', 'expense', '💳'],
  'taxes': ['Taxes', 'expense', '🧾'],
  'travel & vacation': ['Travel', 'expense', '✈️'],
  'travel': ['Travel', 'expense', '✈️'],
  'education': ['Education', 'expense', '🎓'],
  'gifts & donations': ['Gifts & donations', 'expense', '🎁'],
  'charitable donations': ['Gifts & donations', 'expense', '🎁'],
  'professional services': ['Other', 'expense', '📦'],
  'uncategorized': ['Other', 'expense', '📦'],
  'income': ['Other income', 'income', '🎁'],
  'reimbursement': ['Other income', 'income', '🎁'],
  'credit card payment': null,
  'internal transfers': null,
  'savings transfer': null,
  'transfer': null,
  'investment': null,
};

// Name-based overrides, checked before the category map.
const NAME_RULES = [
  [/credit crd autopay|payment to chase card|payment thank you/i, null],
  [/payroll|dir dep|direct dep/i, ['Paycheck', 'income', '💵']],
  [/mtge|mortgage|mtg paymt/i, ['Mortgage / Rent', 'expense', '🏠']],
];

// ---------- CSV parsing ----------

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...body] = rows;
  const keys = header.map((h) => h.replace(/^﻿/, '').trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const toISO = (s) => {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // Chase: MM/DD/YYYY
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/&(*#])([a-z])/g, (_, p, c) => p + c.toUpperCase());

// Normalize every supported format to { date, name, out (money out, + / −), account, sourceCategory, skipType }.
function normalize(rows, fileName) {
  const h = rows[0] || {};
  if ('Account Name' in h && 'Name' in h) {
    return rows.map((r) => ({
      date: toISO(r.Date),
      name: r['Custom Name'] || r.Name || r.Description,
      out: parseFloat(r.Amount),
      account: `${titleCase(r['Account Name'] || 'Account')}${r['Account Number'] ? ` ••${r['Account Number']}` : ''}`,
      sourceCategory: r.Category,
      note: r.Note || '',
      ignored: !!r['Ignored From'],
    }));
  }
  const acct = (fileName.match(/Chase(\d{4})/i) || [])[1];
  if ('Transaction Date' in h) {
    return rows.map((r) => ({
      date: toISO(r['Transaction Date']),
      name: r.Description,
      out: -parseFloat(r.Amount),
      account: `Chase card${acct ? ` ••${acct}` : ''}`,
      sourceCategory: r.Type === 'Payment' ? 'Credit card payment' : r.Category,
      note: r.Memo || '',
    }));
  }
  if ('Posting Date' in h) {
    return rows.map((r) => ({
      date: toISO(r['Posting Date']),
      name: r.Description,
      out: -parseFloat(r.Amount),
      account: `Chase${acct ? ` ••${acct}` : ''}`,
      sourceCategory: /transfer/i.test(r.Type) ? 'Transfer' : '',
      note: '',
    }));
  }
  throw new Error('Unrecognized CSV format. Expected a Chase download or a budgeting-app export.');
}

function classify(t) {
  for (const [re, target] of NAME_RULES) if (re.test(t.name)) return target;
  const key = (t.sourceCategory || '').toLowerCase();
  if (key in CATEGORY_MAP) return CATEGORY_MAP[key];
  return t.out < 0 ? ['Other income', 'income', '🎁'] : ['Other', 'expense', '📦'];
}

// Small stable string hash (cyrb53) for dedupe ids.
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function plan(parsed, fromDate, existingTx, cats) {
  const seen = new Map();
  const out = { add: [], transfers: 0, duplicates: 0, beforeDate: 0, invalid: 0, newCats: new Map() };
  const catKey = (name, type) => `${type}:${name.toLowerCase()}`;
  const catByName = new Map(cats.map((c) => [catKey(c.name, c.type), c]));

  for (const t of parsed) {
    if (!t.date || !Number.isFinite(t.out) || t.out === 0) { out.invalid++; continue; }
    // Same account/date/name/amount can legitimately occur twice in a day; the occurrence count keeps them distinct.
    const base = `${t.account}|${t.date}|${t.name}|${t.out}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (t.date < fromDate) { out.beforeDate++; continue; }
    const target = t.ignored ? null : classify(t);
    if (!target) { out.transfers++; continue; }
    const id = `imp_${hash(`${base}|${n}`)}`;
    if (existingTx.has(id)) { out.duplicates++; continue; }
    const [catName, type, icon] = target;
    if (!catByName.has(catKey(catName, type)) && !out.newCats.has(catKey(catName, type))) {
      out.newCats.set(catKey(catName, type), { name: catName, type, icon });
    }
    out.add.push({
      id,
      date: t.date,
      type,
      amount: Math.round((type === 'income' ? -t.out : t.out) * 100) / 100,
      catKey: catKey(catName, type),
      note: titleCase(t.name).slice(0, 120),
      account: t.account,
      source: 'import',
      createdAt: Date.now(),
    });
  }
  out.catByName = catByName;
  return out;
}

export async function importCSVFile(file) {
  if (store.getState().sandbox) { toast('Importing is turned off in demo mode.'); return; }
  const parsed = normalize(parseCSV(await file.text()), file.name);
  const dates = parsed.map((t) => t.date).filter(Boolean).sort();
  // Read what's already saved straight from the database (screens only keep the months they show in memory).
  const [existingDocs, cats] = await Promise.all([
    store.fetchWhere('transactions', [['date', '>=', dates[0] || '0000-00-00']]),
    store.fetchWhere('categories', []),
  ]);
  const existingTx = new Set(existingDocs.map((t) => t.id));
  const defaultFrom = `${new Date().getFullYear()}-01-01`;

  const dlg = openModal(`
    <form class="form" novalidate>
      <h2>Import transactions</h2>
      <p class="muted small">${esc(file.name)}<br>${parsed.length} rows · ${esc(dates[0] || '?')} to ${esc(dates[dates.length - 1] || '?')}</p>
      <label class="field"><span>Import from</span><input class="input" type="date" name="from" value="${defaultFrom}"></label>
      <div class="import-summary"></div>
      <div class="form-actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-m="cancel">Cancel</button>
        <button type="submit" class="btn primary">Import</button>
      </div>
    </form>`);
  const form = dlg.querySelector('form');
  const summary = form.querySelector('.import-summary');
  let current;

  const refresh = () => {
    current = plan(parsed, form.from.value || '0000-00-00', existingTx, cats);
    const spent = current.add.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const income = current.add.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    summary.innerHTML = `
      <ul class="small steps">
        <li><b>${current.add.length}</b> transactions to import (${money(spent)} spending, ${money(income)} income)</li>
        ${current.transfers ? `<li>${current.transfers} transfers between your own accounts and card payments skipped, so nothing is counted twice</li>` : ''}
        ${current.duplicates ? `<li>${current.duplicates} already imported, skipped</li>` : ''}
        ${current.newCats.size ? `<li>New categories: ${[...current.newCats.values()].map((c) => `${esc(c.icon)} ${esc(c.name)}`).join(', ')}</li>` : ''}
      </ul>`;
    form.querySelector('[type=submit]').disabled = !current.add.length;
  };
  refresh();
  form.from.addEventListener('change', refresh);
  form.querySelector('[data-m=cancel]').onclick = closeModal;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const order = cats.length;
      let i = 0;
      for (const [key, c] of current.newCats) {
        const id = store.add('categories', { ...c, budget: 0, order: order + i++, archived: false });
        current.catByName.set(key, { id, ...c });
      }
      const docs = current.add.map(({ catKey, ...t }) => ({ ...t, categoryId: current.catByName.get(catKey).id }));
      await store.bulkPut('transactions', docs);
      closeModal();
      toast(`Imported ${docs.length} transactions`);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      btn.textContent = 'Import';
      toast(`Import failed: ${err.message}`);
    }
  };
}

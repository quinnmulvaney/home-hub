import * as store from './store.js';
import { esc } from './util.js';
import budget from './modules/budget.js';
import goals from './modules/goals.js';
import wedding from './modules/wedding.js';
import settings from './modules/settings.js';
import { placeholder } from './modules/placeholder.js';

// Each module: { id, title, icon, render(el) -> cleanup? }.
// To add a feature later, write a module and add it here.
const modules = [
  budget,
  goals,
  wedding,
  placeholder('calendar', 'Calendar', '📅', 'Shared household calendar — bills due, appointments, chores.'),
  placeholder('shopping', 'Shopping', '🛒', 'Shared shopping lists that tick off live on every phone.'),
  settings,
];

const nav = document.getElementById('nav');
const view = document.getElementById('view');
const title = document.getElementById('page-title');
const pill = document.getElementById('sync-pill');
let cleanup = null;

nav.innerHTML = `
  <div class="brand"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Home Hub</span></div>
  ${modules.map((m) => `
    <a class="nav-item" href="#/${m.id}" data-id="${m.id}">
      <span class="nav-icon" aria-hidden="true">${m.icon}</span><span class="nav-label">${esc(m.title)}</span>
    </a>`).join('')}`;

function route() {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0] || 'budget';
  const mod = modules.find((m) => m.id === id) || modules[0];
  nav.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.id === mod.id));
  title.textContent = mod.title;
  document.title = `${mod.title} · Home Hub`;
  if (cleanup) cleanup();
  view.innerHTML = '';
  view.className = `view view-${mod.id}`;
  cleanup = mod.render(view) || null;
}

const STATUS = {
  local: ['This device', 'Data is saved on this device only. Set up sync in Settings.'],
  'signed-out': ['Sign in to sync', 'Signed out — data is on this device only.'],
  syncing: ['Syncing…', 'Uploading changes.'],
  synced: ['Synced', 'All changes saved to the cloud.'],
  offline: ['Offline', 'Changes are saved and will sync when you reconnect.'],
  error: ['Sync error', ''],
};

store.onStatus((s) => {
  const [label, tip] = STATUS[s.status] || STATUS.local;
  pill.textContent = label;
  pill.title = s.error || tip;
  pill.dataset.status = s.status;
});
pill.addEventListener('click', () => { location.hash = '#/settings'; });

window.addEventListener('hashchange', route);

view.innerHTML = '<div class="loading">Loading…</div>';
await store.init();
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

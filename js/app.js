import * as store from './store.js';
import { esc, applyAppearance, amountsHidden, setHideAmounts } from './util.js';
import { startAlertMonitor } from './alerts.js';
import home from './modules/home.js';
import budget from './modules/budget.js';
import goals from './modules/goals.js';
import wedding from './modules/wedding.js';
import settings from './modules/settings.js';
import { placeholder } from './modules/placeholder.js';

// Each module: { id, title, icon, render(el) -> cleanup? }.
// To add a feature later, write a module and add it here.
const modules = [
  home,
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
const eye = document.getElementById('privacy-btn');
const banner = document.getElementById('demo-banner');
let cleanup = null;

nav.innerHTML = `
  <a class="brand" href="#/home"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Home Hub</span></a>
  ${modules.map((m) => `
    <a class="nav-item" href="#/${m.id}" data-id="${m.id}">
      <span class="nav-icon" aria-hidden="true">${m.icon}</span><span class="nav-label">${esc(m.title)}</span>
    </a>`).join('')}`;

function route() {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
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
  sandbox: ['Demo mode', 'Showing made-up data. Your real data is untouched.'],
};

store.onStatus((s) => {
  const [label, tip] = STATUS[s.status] || STATUS.local;
  pill.textContent = label;
  pill.title = s.error || tip;
  pill.dataset.status = s.status;
  banner.hidden = !s.sandbox;
  if (s.sandbox) {
    banner.innerHTML = '<span>🎭 <b>Demo mode.</b> Everything here is made up. Your real data is untouched.</span><button class="btn sm" id="exit-demo" type="button">Exit demo</button>';
  }
});
banner.addEventListener('click', async (e) => {
  if (!e.target.closest('#exit-demo')) return;
  await store.setSandbox(false);
  route();
});

// Hide amounts: the eye button in the header (also in Settings → Privacy).
function paintEye() {
  const on = amountsHidden();
  eye.textContent = on ? '🙈' : '👁';
  eye.title = on ? 'Show amounts' : 'Hide amounts';
  eye.setAttribute('aria-label', eye.title);
  eye.setAttribute('aria-pressed', String(on));
}
eye.addEventListener('click', () => setHideAmounts(!amountsHidden()));
window.addEventListener('homehub:privacy', () => { paintEye(); route(); });
paintEye();
pill.addEventListener('click', () => { location.hash = '#/settings'; });

window.addEventListener('hashchange', route);

view.innerHTML = '<div class="loading">Loading…</div>';
applyAppearance();
await store.init();
route();
startAlertMonitor();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

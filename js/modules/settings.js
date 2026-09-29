import * as store from '../store.js';
import { esc, pref, setPref, toast, download, todayISO, PALETTES, applyAppearance } from '../util.js';
import { importCSVFile } from '../importer.js';
import { showSystemNotification } from '../alerts.js';

const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'MXN', 'JPY', 'INR'];

// Chrome/Edge fire this when the app is installable; keep it for the Install button.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

export default {
  id: 'settings',
  title: 'Settings',
  icon: '⚙️',
  render(el) {
    const root = document.createElement('div');
    root.className = 'settings';
    el.appendChild(root);

    function draw(s) {
      root.innerHTML = `
        ${syncCard(s)}
        ${s.mode === 'cloud' ? householdCard(s) : ''}
        ${alertsCard()}
        ${appearanceCard()}
        <section class="card">
          <div class="card-head"><h2>Preferences</h2></div>
          <label class="field"><span>Currency</span>
            <select class="input" data-input="currency">
              ${CURRENCIES.map((c) => `<option ${pref('currency', 'USD') === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </label>
        </section>
        <section class="card">
          <div class="card-head"><h2>Import from your bank</h2></div>
          <p class="muted small">Upload a CSV from Chase (Account activity → Download) or an export from another budgeting app. Transfers between your own accounts are skipped, and re-importing the same file never creates duplicates.</p>
          <label class="btn primary">Import bank CSV<input type="file" accept=".csv,text/csv" data-input="bank-csv" hidden></label>
        </section>
        <section class="card">
          <div class="card-head"><h2>Backup</h2></div>
          <p class="muted small">Download everything as a file, or restore from one. Restoring adds to and overwrites matching items — it never deletes.</p>
          <div class="btn-row">
            <button class="btn" data-action="export">Download backup</button>
            <label class="btn">Restore from file<input type="file" accept="application/json,.json" data-input="import" hidden></label>
          </div>
        </section>
        ${isStandalone() ? '' : `
        <section class="card">
          <div class="card-head"><h2>Install the app</h2></div>
          ${installPrompt ? '<button class="btn primary" data-action="install">Install Home Hub</button>' : `
          <ul class="muted small steps">
            <li><b>Windows (Edge/Chrome):</b> click the install icon (⊕) at the right end of the address bar, or menu ⋯ → Apps → Install.</li>
            <li><b>Android (Chrome):</b> menu ⋮ → <i>Add to Home screen</i> → Install.</li>
          </ul>`}
        </section>`}`;
    }

    function appearanceCard() {
      const cur = pref('palette', 'wedding'), mode = pref('mode', 'auto'), size = pref('textSize', '1'), hc = pref('contrast', '0') === '1';
      const seg = (name, opts, value) => `<div class="seg" role="radiogroup" aria-label="${name}">${opts.map(([v, l]) =>
        `<label><input type="radio" name="ap-${name}" data-appearance="${name}" value="${v}" ${String(value) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
      return `
        <section class="card">
          <div class="card-head"><h2>Appearance</h2></div>
          <div class="swatches" role="radiogroup" aria-label="Color theme">
            ${PALETTES.map((p) => `<button type="button" class="swatch ${cur === p.id ? 'active' : ''}" data-action="palette" data-id="${p.id}" role="radio" aria-checked="${cur === p.id}">
              <span class="dots">${p.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span><span class="sw-name">${esc(p.name)}</span></button>`).join('')}
          </div>
          <div class="field"><span>Light or dark</span>${seg('mode', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], mode)}</div>
          <div class="field"><span>Text size</span>${seg('textSize', [['1', 'Standard'], ['1.15', 'Large'], ['1.3', 'Extra large']], size)}</div>
          <label class="check"><input type="checkbox" data-appearance="contrast" ${hc ? 'checked' : ''}><span><b>High contrast</b><br><span class="muted small">Darker text, stronger borders and outlines.</span></span></label>
          <p class="muted small">Saved on each device, so your phone and PC can look different.</p>
        </section>`;
    }

    function alertsCard() {
      const supported = 'Notification' in window;
      const perm = supported ? Notification.permission : 'unsupported';
      const pushReady = store.pushSupported();
      const pushOn = !!localStorage.getItem('homehub:pushDevice');
      return `
        <section class="card">
          <div class="card-head"><h2>Alerts</h2><span class="badge ${pushOn ? 'ok' : ''}">${pushOn ? 'Phone alerts on' : perm === 'granted' ? 'While app is open' : 'Off'}</span></div>
          <p class="muted small">Get warned when a category is close to its monthly limit. Set the threshold under <a href="#/budget">Budget → Plan</a>.</p>
          ${!supported ? '<p class="muted small">This browser doesn’t support notifications.</p>' : `
          <div class="btn-row">
            ${pushOn
              ? '<button class="btn" data-action="push-off">Turn off phone alerts</button>'
              : `<button class="btn primary" data-action="push-on">${pushReady ? 'Turn on phone alerts' : 'Allow notifications'}</button>`}
            ${perm === 'granted' ? '<button class="btn" data-action="push-test">Send a test</button>' : ''}
          </div>
          ${pushReady ? '<p class="muted small">Phone alerts also arrive when the app is closed, right after the bank sync finds a purchase that pushes a category over its limit.</p>'
            : '<p class="muted small">Alerts show while the app is open. Bank-synced purchases are checked the next time you open it.</p>'}
          ${perm === 'denied' ? '<p class="form-error small">Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.</p>' : ''}`}
        </section>`;
    }

    function syncCard(s) {
      if (!store.isCloudConfigured()) {
        return `
          <section class="card">
            <div class="card-head"><h2>Sync</h2><span class="badge">Not set up</span></div>
            <p>Right now your data is saved <b>on this device only</b>.</p>
            <p class="muted small">To sync between your PC and phone, create a free Firebase project and paste its config into <code>js/firebase-config.js</code>. Step-by-step instructions are in <code>README.md</code>. Anything you enter now can be copied into the cloud when you first sign in.</p>
          </section>`;
      }
      if (s.mode !== 'cloud') {
        return `
          <section class="card">
            <div class="card-head"><h2>Sync</h2><span class="badge">Signed out</span></div>
            <p>Sign in to sync your budget across all your devices.</p>
            ${s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''}
            <button class="btn primary" data-action="sign-in">Sign in with Google</button>
          </section>`;
      }
      return `
        <section class="card">
          <div class="card-head"><h2>Sync</h2><span class="badge ok">${s.status === 'offline' ? 'Offline — will sync later' : 'On'}</span></div>
          <div class="account">
            ${s.user.photo ? `<img src="${esc(s.user.photo)}" alt="" width="36" height="36" referrerpolicy="no-referrer">` : ''}
            <div><div>${esc(s.user.name || '')}</div><div class="muted small">${esc(s.user.email || '')}</div></div>
          </div>
          ${s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''}
          <button class="btn" data-action="sign-out">Sign out</button>
        </section>`;
    }

    function householdCard(s) {
      const h = s.household;
      const members = h?.members?.length || 1;
      return `
        <section class="card">
          <div class="card-head"><h2>Household</h2><span class="muted small">${members} member${members === 1 ? '' : 's'}</span></div>
          <label class="field"><span>Name</span>
            <div class="inline"><input class="input" data-field="hh-name" value="${esc(h?.name || '')}" maxlength="40"><button class="btn" data-action="rename">Save</button></div>
          </label>
          <label class="field"><span>Invite code</span>
            <div class="inline"><input class="input mono" readonly value="${esc(s.householdId)}"><button class="btn" data-action="copy-code">Copy</button></div>
          </label>
          <p class="muted small">Anyone who signs in and enters this code shares this household's data. Only share it with people in your home.</p>
          <details>
            <summary>Join a different household</summary>
            <div class="inline"><input class="input mono" data-field="join-code" placeholder="Paste invite code"><button class="btn" data-action="join">Join</button></div>
            <p class="muted small">You'll switch to that household's data. Your current household stays saved.</p>
          </details>
        </section>`;
    }

    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      try {
        switch (b.dataset.action) {
          case 'sign-in': await store.signIn(); break;
          case 'sign-out': await store.signOut(); toast('Signed out'); break;
          case 'rename': {
            const name = root.querySelector('[data-field=hh-name]').value.trim();
            if (name) { await store.renameHousehold(name); toast('Saved'); }
            break;
          }
          case 'copy-code':
            await navigator.clipboard.writeText(store.getState().householdId);
            toast('Invite code copied');
            break;
          case 'join': {
            const code = root.querySelector('[data-field=join-code]').value.trim();
            if (!code) return;
            if (!confirm('Switch to that household? You will see its data instead of this one.')) return;
            await store.joinHousehold(code);
            toast('Joined household');
            break;
          }
          case 'export': {
            const data = await store.exportAll();
            download(`home-hub-backup-${todayISO()}.json`, JSON.stringify({ app: 'home-hub', version: 1, exportedAt: new Date().toISOString(), data }, null, 2));
            break;
          }
          case 'palette':
            setPref('palette', b.dataset.id);
            applyAppearance();
            lastSig = '';
            draw(store.getState());
            return;
          case 'push-on':
            if (store.pushSupported()) { await store.enablePush(); toast('Phone alerts are on'); }
            else if ((await Notification.requestPermission()) === 'granted') toast('Notifications allowed');
            lastSig = '';
            draw(store.getState());
            break;
          case 'push-off':
            store.disablePush();
            toast('Phone alerts turned off');
            lastSig = '';
            draw(store.getState());
            break;
          case 'push-test':
            if (!(await showSystemNotification('Home Hub', 'Notifications are working. You’ll see budget alerts like this.', 'test'))) toast('Couldn’t show a notification');
            break;
          case 'install':
            installPrompt.prompt();
            await installPrompt.userChoice;
            installPrompt = null;
            draw(store.getState());
            lastSig = '';
            break;
        }
      } catch (err) {
        console.error(err);
        const msg = err.code === 'auth/popup-closed-by-user' ? 'Sign-in cancelled'
          : err.code === 'permission-denied' || err.code === 'not-found' ? 'That invite code didn’t work'
          : err.message || String(err);
        toast(msg);
      }
    });

    root.addEventListener('change', async (e) => {
      const k = e.target.dataset.input;
      if (k === 'currency') { setPref('currency', e.target.value); toast(`Currency set to ${e.target.value}`); }
      if (k === 'bank-csv') {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) importCSVFile(file).catch((err) => toast(err.message));
        return;
      }
      if (k === 'import') {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          const data = parsed.data || parsed;
          const counts = Object.entries(data).filter(([, v]) => Array.isArray(v));
          if (!counts.length) throw new Error('No data found in that file');
          const total = counts.reduce((n, [, v]) => n + v.length, 0);
          if (!confirm(`Restore ${total} items from this backup?`)) return;
          for (const [coll, docs] of counts) await store.bulkPut(coll, docs);
          toast(`Restored ${total} items`);
        } catch (err) {
          toast(`Restore failed: ${err.message}`);
        } finally {
          e.target.value = '';
        }
      }
    });

    root.addEventListener('change', (e) => {
      const a = e.target.dataset.appearance;
      if (!a) return;
      setPref(a, a === 'contrast' ? (e.target.checked ? '1' : '0') : e.target.value);
      applyAppearance();
    });

    // Redraw only when something shown here changes (not on every syncing→synced blip,
    // which would wipe what you're typing).
    let lastSig = '';
    return store.onStatus((s) => {
      const sig = JSON.stringify([s.mode, s.status === 'offline', s.error, s.user?.uid, s.householdId, s.household?.name, s.household?.members?.length]);
      if (sig !== lastSig) { lastSig = sig; draw(s); }
    });
  },
};

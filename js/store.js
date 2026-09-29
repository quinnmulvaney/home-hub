// Data layer shared by every module (budget, calendar, lists...).
// Two backends behind one API:
//   local — browser localStorage, this device only (used when sync isn't set up or you're signed out)
//   cloud — Firestore under households/{householdId}/{collection}, synced live, works offline
// Modules only call subscribe / add / put / update / remove and never care which backend is active.
import { firebaseConfig, vapidKey } from './firebase-config.js';
import { newId, todayISO } from './util.js';
import { generateDemo } from './demo.js';

const FIREBASE_VERSION = '11.0.2';
const LOCAL_KEY = 'homehub:data';
const SEEDED_KEY = 'homehub:seeded';
const SANDBOX_KEY = 'homehub:sandbox';            // '1' while demo mode is on
const SANDBOX_DATA_KEY = 'homehub:sandbox:data';   // demo data lives apart from real data

const state = {
  mode: 'local',        // 'local' | 'cloud'   (demo mode uses 'local' with sandbox = true)
  sandbox: false,       // demo mode: made-up data, real data untouched
  status: 'local',      // 'local' | 'signed-out' | 'syncing' | 'synced' | 'offline' | 'error' | 'sandbox'
  error: '',
  user: null,
  householdId: null,
  household: null,
};

const cache = {};                 // collection -> Map(id -> doc)
const subs = {};                  // collection -> Set(callback)
const statusSubs = new Set();
const seeds = [];                 // functions that create starter data in a brand-new store
const collections = new Set();    // every collection a module has declared (for export/migration)
let local = {};                   // collection -> { id: doc }  (local backend)
let fb = null;                    // firebase modules + instances once loaded
let cloudUnsubs = [];
const pending = {};               // collection -> has un-uploaded writes

export const isCloudConfigured = () =>
  !!(firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('PASTE'));

export const getState = () => ({ ...state });

// Who is using the app right now (demo and signed-out modes get stand-in ids).
export const meId = () => (state.sandbox ? 'demo-me' : state.user?.uid || 'local');
export const meName = () => (state.sandbox ? 'Alex' : (state.user?.name || '').trim().split(/\s+/)[0] || 'Me');

export function onStatus(cb) {
  statusSubs.add(cb);
  cb(getState());
  return () => statusSubs.delete(cb);
}

function setStatus(status, error = '') {
  state.status = status;
  state.error = error;
  statusSubs.forEach((cb) => cb(getState()));
}

export function registerCollections(names) { names.forEach((n) => collections.add(n)); }
export function registerSeed(fn) { seeds.push(fn); }

// ---------- reading ----------

function emit(coll) {
  const list = [...(cache[coll]?.values() || [])];
  subs[coll]?.forEach((cb) => cb(list));
  if (state.mode === 'local') whereSubs.forEach((s) => { if (s.coll === coll) s.cb(localMatches(s.coll, s.conds)); });
}

// ---------- filtered subscriptions (only load what a screen needs) ----------
// conds: [[field, '==' | '>=' | '<=' | '>' | '<', value], ...]. Firestore serves these from an
// automatic single-field index. Keep them to one range field so no composite index is needed.

const whereSubs = new Set();
let whereCounter = 0;

function matchDoc(doc, conds) {
  return conds.every(([f, op, v]) => {
    const x = doc[f];
    if (x === undefined || x === null) return false;
    return op === '==' ? x === v : op === '>=' ? x >= v : op === '<=' ? x <= v : op === '>' ? x > v : x < v;
  });
}
const localMatches = (coll, conds) => getAll(coll).filter((d) => matchDoc(d, conds));

function cloudQuery(coll, conds) {
  const { collection, query, where } = fb.fs;
  return query(collection(fb.db, 'households', state.householdId, coll), ...conds.map((c) => where(...c)));
}

function attachWhere(sub) {
  sub.unsub?.();
  sub.unsub = null;
  delete pending[sub.key];
  if (state.mode === 'cloud') {
    sub.unsub = fb.fs.onSnapshot(cloudQuery(sub.coll, sub.conds), { includeMetadataChanges: true }, (qs) => {
      pending[sub.key] = qs.metadata.hasPendingWrites;
      sub.cb(qs.docs.map((d) => ({ ...d.data(), id: d.id })));
      refreshSyncStatus();
    }, writeFailed);
  } else {
    sub.cb(localMatches(sub.coll, sub.conds));
  }
}

export function subscribeWhere(coll, conds, cb) {
  collections.add(coll);
  const sub = { coll, conds, cb, unsub: null, key: `where${++whereCounter}` };
  whereSubs.add(sub);
  attachWhere(sub);
  return () => {
    whereSubs.delete(sub);
    sub.unsub?.();
    delete pending[sub.key];
  };
}

// How many docs match, without downloading them (server-side count; local mode counts in memory).
export async function countWhere(coll, conds) {
  if (state.mode !== 'cloud') return localMatches(coll, conds).length;
  const snap = await fb.fs.getCountFromServer(cloudQuery(coll, conds));
  return snap.data().count;
}

// Merge the same `patch` into many docs at once (chunked to Firestore's batch limit).
export async function bulkUpdate(coll, ids, patch) {
  if (state.mode !== 'cloud') { ids.forEach((id) => update(coll, id, patch)); return; }
  const { doc: ref, writeBatch } = fb.fs;
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(fb.db);
    ids.slice(i, i + 400).forEach((id) => batch.set(ref(fb.db, 'households', state.householdId, coll, id), { ...patch, id, updatedAt: Date.now() }, { merge: true }));
    await batch.commit();
  }
}

export async function fetchWhere(coll, conds) {
  if (state.mode !== 'cloud') return localMatches(coll, conds);
  const qs = await fb.fs.getDocs(cloudQuery(coll, conds));
  return qs.docs.map((d) => ({ ...d.data(), id: d.id }));
}

export function subscribe(coll, cb) {
  collections.add(coll);
  (subs[coll] ||= new Set()).add(cb);
  if (state.mode === 'cloud') attachCloud(coll);
  cb([...(cache[coll]?.values() || [])]);
  return () => subs[coll].delete(cb);
}

export function getAll(coll) { return [...(cache[coll]?.values() || [])]; }

// ---------- writing ----------

export function add(coll, data) { return put(coll, newId(), data); }

export function put(coll, id, data) {
  const doc = { ...data, id, updatedAt: Date.now() };
  if (state.mode === 'cloud') {
    // Not awaited on purpose: offline writes only resolve once the server acks,
    // but the snapshot listener shows the change immediately.
    const { doc: ref, setDoc } = fb.fs;
    setDoc(ref(fb.db, 'households', state.householdId, coll, id), doc).catch(writeFailed);
  } else {
    (local[coll] ||= {})[id] = doc;
    saveLocal();
    (cache[coll] ||= new Map()).set(id, doc);
    emit(coll);
  }
  return id;
}

// Merge `patch` into an existing doc. In the cloud this is a server-side merge, so it works even
// when the doc isn't in memory (screens only load the date range they show).
export function update(coll, id, patch) {
  if (state.mode === 'cloud') {
    const { doc: ref, setDoc } = fb.fs;
    setDoc(ref(fb.db, 'households', state.householdId, coll, id), { ...patch, id, updatedAt: Date.now() }, { merge: true }).catch(writeFailed);
    return;
  }
  const existing = local[coll]?.[id];
  if (existing) put(coll, id, { ...existing, ...patch });
}

export function remove(coll, id) {
  if (state.mode === 'cloud') {
    const { doc: ref, deleteDoc } = fb.fs;
    deleteDoc(ref(fb.db, 'households', state.householdId, coll, id)).catch(writeFailed);
  } else {
    delete local[coll]?.[id];
    saveLocal();
    cache[coll]?.delete(id);
    emit(coll);
  }
}

// Many writes at once (import / migration). Awaited, chunked to Firestore's batch limit.
export async function bulkPut(coll, docs) {
  if (state.mode !== 'cloud') {
    docs.forEach((d) => put(coll, d.id || newId(), d));
    return;
  }
  const { doc: ref, writeBatch } = fb.fs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(fb.db);
    docs.slice(i, i + 400).forEach((d) => {
      const id = d.id || newId();
      batch.set(ref(fb.db, 'households', state.householdId, coll, id), { ...d, id, updatedAt: Date.now() });
    });
    await batch.commit();
  }
}

export async function exportAll() {
  const out = {};
  for (const coll of collections) {
    if (state.mode === 'cloud' && !cache[coll]) {
      const { collection, getDocs } = fb.fs;
      const qs = await getDocs(collection(fb.db, 'households', state.householdId, coll));
      out[coll] = qs.docs.map((d) => ({ ...d.data(), id: d.id }));
    } else {
      out[coll] = getAll(coll);
    }
  }
  return out;
}

function writeFailed(err) {
  console.error(err);
  setStatus('error', err.message || String(err));
}

// ---------- local backend ----------

function loadLocal() {
  try { local = JSON.parse(localStorage.getItem(state.sandbox ? SANDBOX_DATA_KEY : LOCAL_KEY)) || {}; } catch { local = {}; }
}

function saveLocal() {
  try { localStorage.setItem(state.sandbox ? SANDBOX_DATA_KEY : LOCAL_KEY, JSON.stringify(local)); } catch (e) { writeFailed(e); }
}

function localHasData() {
  return Object.values(local).some((docs) => Object.keys(docs || {}).length > 0);
}

function fillCacheFromLocal() {
  for (const k of Object.keys(cache)) delete cache[k];
  for (const [coll, docs] of Object.entries(local)) cache[coll] = new Map(Object.entries(docs || {}));
  Object.keys(subs).forEach(emit);
  whereSubs.forEach(attachWhere);
}

async function startLocal(status) {
  state.sandbox = false;
  state.mode = 'local';
  state.user = null;
  state.householdId = null;
  state.household = null;
  loadLocal();
  let seeded = false;
  try { seeded = localStorage.getItem(SEEDED_KEY) === '1'; } catch {}
  if (!seeded && !localHasData()) {
    for (const seed of seeds) await seed(put);
    try { localStorage.setItem(SEEDED_KEY, '1'); } catch {}
  }
  fillCacheFromLocal();
  setStatus(status);
}

// ---------- demo (sandbox) mode ----------
// Swaps in a generated, fictional household. Real data (local or cloud) is never read or written meanwhile.

let lastUser = null;   // the signed-in Firebase user, so leaving demo mode can go straight back to the cloud

async function startSandbox() {
  state.sandbox = true;
  state.mode = 'local';
  state.user = null;
  state.householdId = null;
  state.household = null;
  loadLocal();
  if (!Object.keys(local).length) { local = generateDemo(todayISO()); saveLocal(); }
  fillCacheFromLocal();
  setStatus('sandbox');
}

export async function setSandbox(on) {
  try { on ? localStorage.setItem(SANDBOX_KEY, '1') : localStorage.removeItem(SANDBOX_KEY); } catch {}
  detachCloud();
  if (on) await startSandbox();
  else {
    state.sandbox = false;
    if (lastUser) await startCloud(lastUser);
    else await startLocal(fb ? 'signed-out' : 'local');
  }
  window.dispatchEvent(new Event('homehub:datasource'));
}

export function resetSandbox() {
  if (!state.sandbox) return;
  local = generateDemo(todayISO());
  saveLocal();
  fillCacheFromLocal();
  window.dispatchEvent(new Event('homehub:datasource'));
}

// ---------- cloud backend ----------

async function loadFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appMod, auth, fs] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  fb = { auth, fs, db, app, au: auth.getAuth(app) };
}

export async function init() {
  try { state.sandbox = localStorage.getItem(SANDBOX_KEY) === '1'; } catch {}
  if (!isCloudConfigured()) return state.sandbox ? startSandbox() : startLocal('local');
  try {
    await loadFirebase();
  } catch (e) {
    console.error(e);
    if (state.sandbox) { await startSandbox(); return; }
    await startLocal('error');
    setStatus('error', 'Could not load the sync library — check your connection.');
    return;
  }
  window.addEventListener('online', refreshSyncStatus);
  window.addEventListener('offline', refreshSyncStatus);
  // Resolve init once we know whether someone is signed in.
  let firstAuth = true;
  await new Promise((resolve) => {
    fb.auth.onAuthStateChanged(fb.au, async (user) => {
      lastUser = user;
      try {
        if (state.sandbox) { if (firstAuth) await startSandbox(); }   // demo mode ignores sign-in changes
        else if (user) await startCloud(user);
        else { detachCloud(); await startLocal('signed-out'); }
      } catch (e) {
        writeFailed(e);
      }
      firstAuth = false;
      resolve();
    });
  });
}

export async function signIn() {
  const provider = new fb.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await fb.auth.signInWithPopup(fb.au, provider);
}

export async function signOut() { await fb.auth.signOut(fb.au); }

async function startCloud(user) {
  const { doc, getDoc, setDoc } = fb.fs;
  state.user = { uid: user.uid, email: user.email, name: user.displayName, photo: user.photoURL };
  const hidKey = `homehub:hid:${user.uid}`;
  const userRef = doc(fb.db, 'users', user.uid);

  let hid = null;
  try {
    const snap = await getDoc(userRef);
    hid = snap.exists() ? snap.data().householdId : null;
  } catch {
    // Offline and not cached yet — fall back to what this device remembers.
    try { hid = localStorage.getItem(hidKey); } catch {}
  }

  let isNew = false;
  if (!hid) {
    hid = newId(20);
    await setDoc(doc(fb.db, 'households', hid), {
      name: 'Our Home',
      members: [user.uid],
      createdBy: user.uid,
      createdAt: Date.now(),
    });
    await setDoc(userRef, { householdId: hid, email: user.email || '', name: user.displayName || '' });
    isNew = true;
  }
  try { localStorage.setItem(hidKey, hid); } catch {}

  enterHousehold(hid);
  linkDeviceToUser(user.uid);

  if (isNew) {
    loadLocal();
    if (localHasData() && confirm('Copy the data already on this device into your new synced household?')) {
      for (const [coll, docs] of Object.entries(local)) await bulkPut(coll, Object.values(docs || {}));
      local = {};
      saveLocal();
    } else {
      for (const seed of seeds) await seed(put);
    }
  }
}

// Push notifications for a specific person need to know whose phone a token belongs to.
async function linkDeviceToUser(uid) {
  let id = null;
  try { id = localStorage.getItem('homehub:pushDevice'); } catch { /* storage blocked */ }
  if (!id) return;
  try {
    const { doc, getDoc, setDoc } = fb.fs;
    const ref = doc(fb.db, 'households', state.householdId, 'devices', id);
    const snap = await getDoc(ref);
    if (snap.exists() && !snap.data().uid) await setDoc(ref, { uid }, { merge: true });
  } catch { /* offline: try again next time */ }
}

function enterHousehold(hid) {
  detachCloud();
  state.sandbox = false;
  state.mode = 'cloud';
  state.householdId = hid;
  for (const k of Object.keys(cache)) delete cache[k];
  Object.keys(subs).forEach(emit);

  const { doc, onSnapshot } = fb.fs;
  cloudUnsubs.push(onSnapshot(doc(fb.db, 'households', hid), (snap) => {
    state.household = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    refreshSyncStatus();
  }, writeFailed));
  for (const coll of Object.keys(subs)) attachCloud(coll);
  whereSubs.forEach(attachWhere);
  refreshSyncStatus();
}

const attached = new Set();
function attachCloud(coll) {
  if (attached.has(coll)) return;
  attached.add(coll);
  const { collection, onSnapshot } = fb.fs;
  cloudUnsubs.push(onSnapshot(
    collection(fb.db, 'households', state.householdId, coll),
    { includeMetadataChanges: true },
    (qs) => {
      const m = new Map();
      qs.forEach((d) => m.set(d.id, { ...d.data(), id: d.id }));
      cache[coll] = m;
      pending[coll] = qs.metadata.hasPendingWrites;
      emit(coll);
      refreshSyncStatus();
    },
    writeFailed,
  ));
}

function detachCloud() {
  whereSubs.forEach((sub) => { sub.unsub?.(); sub.unsub = null; });
  cloudUnsubs.forEach((u) => u());
  cloudUnsubs = [];
  attached.clear();
  for (const k of Object.keys(pending)) delete pending[k];
}

function refreshSyncStatus() {
  if (state.mode !== 'cloud') return;
  if (!navigator.onLine) return setStatus('offline');
  setStatus(Object.values(pending).some(Boolean) ? 'syncing' : 'synced');
}

export async function renameHousehold(name) {
  const { doc, updateDoc } = fb.fs;
  await updateDoc(doc(fb.db, 'households', state.householdId), { name });
}

// Invites. A code is random, good for 3 days and works once. The household's own id is never shared, so seeing it
// somewhere (a screenshot, a log) can't be used to get in.
const INVITE_DAYS = 3;
const inviteCode = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

export async function createInvite() {
  if (state.mode !== 'cloud') throw new Error('Sign in first.');
  const { doc, setDoc } = fb.fs;
  const code = inviteCode();
  const expiresAt = Date.now() + INVITE_DAYS * 864e5;
  await setDoc(doc(fb.db, 'invites', code), { householdId: state.householdId, createdBy: state.user.uid, expiresAt });
  return { code, expiresAt };
}

// Join someone else's household with an invite code they created for you.
export async function joinHousehold(code) {
  code = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 8) throw new Error('That doesn\'t look like an invite code.');
  const { doc, getDoc, updateDoc, setDoc, deleteDoc, arrayUnion } = fb.fs;
  const invite = await getDoc(doc(fb.db, 'invites', code));
  if (!invite.exists() || !(invite.data().expiresAt > Date.now())) throw new Error('That invite code is invalid or has expired.');
  const hid = invite.data().householdId;
  await updateDoc(doc(fb.db, 'households', hid), { members: arrayUnion(state.user.uid), joinCode: code });
  await setDoc(doc(fb.db, 'users', state.user.uid), { householdId: hid }, { merge: true });
  try { await deleteDoc(doc(fb.db, 'invites', code)); } catch { /* it expires on its own */ }
  try { localStorage.setItem(`homehub:hid:${state.user.uid}`, hid); } catch {}
  enterHousehold(hid);
}

// ---------- push notifications (Firebase Cloud Messaging) ----------
// A device registers its FCM token under households/{id}/devices; the bank-sync job sends
// spending-limit alerts to every registered device. Needs the Web Push key pair from
// Firebase console → Project settings → Cloud Messaging → Web Push certificates.

export const pushSupported = () =>
  isCloudConfigured() && !!vapidKey && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

async function deviceId(token) {
  const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export async function enablePush() {
  if (state.mode !== 'cloud') throw new Error('Sign in first so alerts can reach this device.');
  if (!pushSupported()) throw new Error('Push alerts need the Web Push key in js/firebase-config.js.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were blocked. Allow them in your browser settings for this site.');
  const { getMessaging, getToken } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-messaging.js`);
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(fb.app), { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error('Could not get a push token for this device.');
  const id = await deviceId(token);
  put('devices', id, { token, uid: state.user?.uid || '', platform: navigator.userAgentData?.platform || navigator.platform || '', addedBy: state.user?.email || '' });
  try { localStorage.setItem('homehub:pushDevice', id); } catch {}
  return id;
}

export function disablePush() {
  let id = null;
  try { id = localStorage.getItem('homehub:pushDevice'); localStorage.removeItem('homehub:pushDevice'); } catch {}
  if (id && state.mode === 'cloud') remove('devices', id);
}

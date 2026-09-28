// Data layer shared by every module (budget, calendar, lists...).
// Two backends behind one API:
//   local — browser localStorage, this device only (used when sync isn't set up or you're signed out)
//   cloud — Firestore under households/{householdId}/{collection}, synced live, works offline
// Modules only call subscribe / add / put / update / remove and never care which backend is active.
import { firebaseConfig } from './firebase-config.js';
import { newId } from './util.js';

const FIREBASE_VERSION = '11.0.2';
const LOCAL_KEY = 'homehub:data';
const SEEDED_KEY = 'homehub:seeded';

const state = {
  mode: 'local',        // 'local' | 'cloud'
  status: 'local',      // 'local' | 'signed-out' | 'syncing' | 'synced' | 'offline' | 'error'
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

export function update(coll, id, patch) {
  const existing = cache[coll]?.get(id);
  if (!existing) return;
  put(coll, id, { ...existing, ...patch });
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
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch { local = {}; }
}

function saveLocal() {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch (e) { writeFailed(e); }
}

function localHasData() {
  return Object.values(local).some((docs) => Object.keys(docs || {}).length > 0);
}

async function startLocal(status) {
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
  for (const k of Object.keys(cache)) delete cache[k];
  for (const [coll, docs] of Object.entries(local)) cache[coll] = new Map(Object.entries(docs || {}));
  Object.keys(subs).forEach(emit);
  setStatus(status);
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
  fb = { auth, fs, db, au: auth.getAuth(app) };
}

export async function init() {
  if (!isCloudConfigured()) return startLocal('local');
  try {
    await loadFirebase();
  } catch (e) {
    console.error(e);
    await startLocal('error');
    setStatus('error', 'Could not load the sync library — check your connection.');
    return;
  }
  window.addEventListener('online', refreshSyncStatus);
  window.addEventListener('offline', refreshSyncStatus);
  // Resolve init once we know whether someone is signed in.
  await new Promise((resolve) => {
    fb.auth.onAuthStateChanged(fb.au, async (user) => {
      try {
        if (user) await startCloud(user);
        else { detachCloud(); await startLocal('signed-out'); }
      } catch (e) {
        writeFailed(e);
      }
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

function enterHousehold(hid) {
  detachCloud();
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

// Join someone else's household using its invite code (the household id).
export async function joinHousehold(code) {
  code = code.trim();
  const { doc, updateDoc, setDoc, arrayUnion } = fb.fs;
  await updateDoc(doc(fb.db, 'households', code), { members: arrayUnion(state.user.uid) });
  await setDoc(doc(fb.db, 'users', state.user.uid), { householdId: code }, { merge: true });
  try { localStorage.setItem(`homehub:hid:${state.user.uid}`, code); } catch {}
  enterHousehold(code);
}

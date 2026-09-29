// The people in the household (each signed-in Google account is one). Profiles live in `people/{uid}` so everyone
// sees the same names and colors. Your own profile is created automatically the first time you open the calendar.
import * as store from './store.js';

export const PERSON_COLORS = ['#4f7396', '#0f7f5f', '#b58a2a', '#a4576b', '#6a5bb5', '#dd6b3a', '#3f7d6d', '#5f7280'];

let people = [];
const listeners = new Set();

export function startPeople() {
  store.subscribe('people', (list) => {
    people = [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.name || '').localeCompare(b.name || ''));
    listeners.forEach((cb) => cb(people));
  });
  const ensure = () => {
    const id = store.meId();
    const existing = store.getAll('people');
    if (existing.some((p) => p.id === id)) return;
    store.put('people', id, { name: store.meName(), color: PERSON_COLORS[existing.length % PERSON_COLORS.length], createdAt: Date.now(), digest: true });
  };
  // Wait a moment so the household's real data has arrived before deciding a profile is missing.
  setTimeout(ensure, 3000);
  window.addEventListener('homehub:datasource', () => setTimeout(ensure, 1500));
}

export const getPeople = () => people;
export const personById = (id) => people.find((p) => p.id === id) || { id, name: 'Someone', color: '#8a8a8a' };
export const me = () => people.find((p) => p.id === store.meId()) || { id: store.meId(), name: store.meName(), color: PERSON_COLORS[0] };
export const initial = (p) => (p.name || '?').trim().slice(0, 1).toUpperCase();
export function subscribePeople(cb) {
  listeners.add(cb);
  cb(people);
  return () => listeners.delete(cb);
}
// People to offer in pickers: at least you.
export const roster = () => (people.length ? people : [me()]);

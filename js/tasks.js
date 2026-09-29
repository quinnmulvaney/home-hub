// Tasks you can hand to someone with one tap. Giving a task to another person:
//   - puts it on their day (status 'pending' until they accept it or pass it back),
//   - adds a notification for them (shows instantly if their app is open),
//   - queues a phone push in `outbox` that the server job delivers within minutes.
import * as store from './store.js';
import { logNotification } from './notifications.js';
import { me, personById } from './people.js';

const myId = () => store.meId();
const isCloud = () => store.getState().mode === 'cloud' && !store.getState().sandbox;

export function queuePush(toUid, title, body) {
  if (!isCloud() || !toUid || toUid === myId()) return;
  store.add('outbox', { toUid, title, body, link: '#/calendar', ts: Date.now() });
}

function notifyAssigned(taskId, toUid, title, stamp) {
  const from = me().name;
  queuePush(toUid, `${from} gave you a task`, title);
  logNotification({ id: `task-${taskId}-${stamp}`, kind: 'task', title: `${from} gave you a task`, body: title, link: '#/calendar', forUid: toUid });
}

export function createTask(title, assignee, extra = {}) {
  const toOther = assignee && assignee !== myId();
  const now = Date.now();
  const id = store.add('tasks', {
    title, notes: '', due: '', ...extra, assignee, createdBy: myId(), createdAt: now,
    assignedBy: assignee ? myId() : '', assignedAt: assignee ? now : 0, status: toOther ? 'pending' : assignee ? 'accepted' : 'open',
  });
  if (toOther) notifyAssigned(id, assignee, title, now);
  return id;
}

// Returns the previous assignment so callers can offer Undo.
export function assignTask(task, toUid, extra = {}) {
  const now = Date.now();
  const toOther = toUid && toUid !== myId();
  const prev = { assignee: task.assignee || '', status: task.status, assignedBy: task.assignedBy || '', assignedAt: task.assignedAt || 0, declinedBy: task.declinedBy || '' };
  store.update('tasks', task.id, { ...extra, assignee: toUid, assignedBy: toUid ? myId() : '', assignedAt: now, declinedBy: '', status: toOther ? 'pending' : toUid ? 'accepted' : 'open' });
  if (toOther) notifyAssigned(task.id, toUid, task.title, now);
  return prev;
}

export function acceptTask(id) {
  store.update('tasks', id, { status: 'accepted', acceptedAt: Date.now() });
}

// "Not today": it goes back to whoever gave it to you, and they get a nudge.
export function declineTask(task) {
  const back = task.assignedBy && task.assignedBy !== myId() ? task.assignedBy : '';
  store.update('tasks', task.id, { assignee: back, assignedBy: back ? myId() : '', status: back ? 'pending' : 'open', declinedBy: myId() });
  if (back) {
    queuePush(back, `${me().name} passed on a task`, task.title);
    logNotification({ id: `pass-${task.id}-${Date.now()}`, kind: 'task', title: `${me().name} passed on a task`, body: task.title, link: '#/calendar', forUid: back });
  }
  return back;
}

export const nameOf = (uid) => personById(uid).name;

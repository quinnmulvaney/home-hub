"""Fast job (runs every few minutes): deliver queued push notifications and send each person's morning summary.

  1. `outbox`: when someone hands a task to another person, the app queues a push here; this job sends it to that
     person's phones and removes it, so it arrives within minutes.
  2. Morning summary: around 7 AM local time, once a day per person, a notification listing today's events and tasks.
     Calendars marked as work schedules are left out.

Cheap by design: a normal run reads only the (usually empty) outbox and one small state document.
The repo is PUBLIC, so this logs counts only: never names, titles, amounts or ids.

Env: FIREBASE_SERVICE_ACCOUNT, HOUSEHOLD_ID (both secrets), TZ_NAME (default America/New_York), DRY_RUN.
"""
import datetime as dt
import json
import os
import time
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, firestore, messaging

import insights

TZ = ZoneInfo(os.environ.get("TZ_NAME") or "America/New_York")
DRY_RUN = (os.environ.get("DRY_RUN") or "").lower() == "true"


def log(*a):
    print(*a, flush=True)


def tokens_for(hh, uid):
    """[(device doc id, token)] for one person's phones. Phones not yet linked to a person are never used."""
    out = []
    for dev in hh.collection("devices").stream():
        data = dev.to_dict() or {}
        if data.get("uid") == uid and data.get("token"):
            out.append((dev.id, data["token"]))
    return out


def push(hh, devices, title, body, link="./#/calendar", tag="homehub"):
    """Send to the given devices; forget phones that are gone. Returns how many were delivered."""
    if not devices or DRY_RUN:
        return 0
    message = messaging.MulticastMessage(
        tokens=[t for _, t in devices],
        data={"title": title, "body": body, "url": link, "tag": tag},
        webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "3600"}),
    )
    response = messaging.send_each_for_multicast(message)
    for (doc_id, _), r in zip(devices, response.responses):
        if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
            hh.collection("devices").document(doc_id).delete()
    return response.success_count


COLORS = ["#4f7396", "#0f7f5f", "#b58a2a", "#a4576b", "#6a5bb5", "#dd6b3a", "#3f7d6d", "#5f7280"]


def seed_people(hh):
    """Make sure every household member has a profile, so they show up in the calendar's pickers even before they have
    opened the Calendar tab themselves. Names come from their Google account. Returns how many were created."""
    from firebase_admin import auth
    members = (hh.get().to_dict() or {}).get("members") or []
    existing = {p.id for p in hh.collection("people").stream()}
    made = 0
    for uid in members:
        if uid in existing:
            continue
        try:
            user = auth.get_user(uid)
        except Exception:
            continue
        name = (user.display_name or (user.email or "").split("@")[0] or "Partner").split(" ")[0]
        if not DRY_RUN:
            hh.collection("people").document(uid).set(
                {"name": name, "color": COLORS[(len(existing) + made) % len(COLORS)], "createdAt": int(time.time() * 1000), "digest": True, "seeded": True})
        made += 1
    return made


def run(hh, now):
    today = now.date().isoformat()
    delivered = 0

    try:
        made = seed_people(hh)
        if made:
            log(f"Profiles created for {made} household member(s)")
    except Exception as e:
        log(f"Profile check skipped: {type(e).__name__}")

    # 1) queued pushes (task hand-offs)
    queued = list(hh.collection("outbox").stream())
    sent = 0
    for item in queued:
        data = item.to_dict() or {}
        devices = tokens_for(hh, data.get("toUid"))
        delivered += push(hh, devices, data.get("title", "Home Hub"), data.get("body", ""), tag="task")
        sent += 1
        if not DRY_RUN:
            hh.collection("outbox").document(item.id).delete()
    if queued:
        log(f"Outbox: {sent} processed")

    # 2) morning summaries
    people = {p.id: (p.to_dict() or {}) for p in hh.collection("people").stream()}
    state_ref = hh.collection("bankSync").document("digest")
    st = state_ref.get()
    state = (st.to_dict() or {}) if st.exists else {}
    due = []
    for uid, p in people.items():
        hour = int(p.get("digestHour") or 7)
        if p.get("digest") is False or state.get(uid) == today or not (hour <= now.hour < hour + 4):
            continue
        due.append(uid)
    if due:
        calendars = {c.id: (c.to_dict() or {}) for c in hh.collection("calendars").stream()}
        events = [dict(e.to_dict() or {}, id=e.id) for e in hh.collection("events").stream()]
        tasks = [dict(t.to_dict() or {}, id=t.id) for t in hh.collection("tasks").stream()]
        statuses = [s.to_dict() or {} for s in hh.collection("statuses").stream() if (s.to_dict() or {}).get("date") == today]
        made = 0
        for uid in due:
            name = people[uid].get("name", "")
            summary = insights.morning_summary(uid, name, today, calendars, events, tasks, statuses, people)
            state[uid] = today
            if not summary:
                continue
            title, body, _ = summary
            made += 1
            delivered += push(hh, tokens_for(hh, uid), title, body, link="./#/home", tag="morning")
            if not DRY_RUN:
                hh.collection("notifications").document(f"digest-{uid}-{today}").set(
                    {"kind": "digest", "title": title, "body": body, "link": "#/home", "quiet": False, "forUid": uid, "ts": int(time.time() * 1000)})
        if not DRY_RUN:
            state_ref.set(state, merge=True)
        log(f"Morning summary: {made} of {len(due)} sent")
    if delivered or queued or due:
        log(f"Delivered {delivered} push notification(s)")
    return delivered


def main():
    key = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    hid = os.environ.get("HOUSEHOLD_ID", "").strip()
    if not key or not hid:
        raise SystemExit("Missing FIREBASE_SERVICE_ACCOUNT or HOUSEHOLD_ID secret.")
    firebase_admin.initialize_app(credentials.Certificate(json.loads(key)))
    run(firestore.client().collection("households").document(hid), dt.datetime.now(TZ))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # keep tracebacks (which can contain data) out of public logs
        log(f"Outbox job failed: {type(e).__name__}")
        raise SystemExit(1)

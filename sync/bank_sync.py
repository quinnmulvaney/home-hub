"""Pull bank transactions from SimpleFIN Bridge into the household's Firestore data.

Runs on a schedule in GitHub Actions (.github/workflows/bank-sync.yml).
The repo is PUBLIC, so this script only ever logs counts: never amounts, merchants, names or URLs.

Env:
  SIMPLEFIN_ACCESS_URL      secret, from tools/setup_bank_sync.py
  FIREBASE_SERVICE_ACCOUNT  secret, the service-account key JSON
  HOUSEHOLD_ID              optional; auto-detected when there is exactly one household
  LOOKBACK_DAYS             how far back to ask SimpleFIN for (default 30)
  DRY_RUN                   "true" = compute everything, write nothing
  TZ_NAME                   timezone for transaction dates (default America/New_York)
"""
import base64
import collections
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, firestore, messaging

import insights

TZ = ZoneInfo(os.environ.get("TZ_NAME") or "America/New_York")
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS") or 30)
DRY_RUN = (os.environ.get("DRY_RUN") or "").lower() == "true"

# Money moving between your own accounts: never counted as spending or income.
TRANSFER_RE = re.compile(
    r"payment thank you|payment to chase card|credit crd|autopay|online transfer|transfer (to|from)"
    r"|internet transfer|savings transfer",
    re.I,
)
# Name rules applied before anything learned: (regex, category name, type).
NAME_RULES = [
    (re.compile(r"payroll|dir dep|direct dep", re.I), "Paycheck", "income"),
    (re.compile(r"mtge|mortgage|mtg paymt", re.I), "Mortgage / Rent", "expense"),
]


def log(*args):
    print(*args, flush=True)


def merchant_key(text):
    """Normalized merchant name used to learn and apply categories. Mirrored in js/merchant.js."""
    s = (text or "").lower()
    s = re.sub(r"^(sq \*|sq\*|tst\* ?|sp \*?|pp\*|paypal \*|dd \*|in \*)", "", s)
    s = re.sub(r"[^a-z ]+", " ", s)
    words = [w for w in s.split() if len(w) > 1][:3]
    return " ".join(words)


# Single words too generic to identify a merchant on their own.
GENERIC_WORDS = {"the", "payment", "online", "purchase", "pos", "debit", "credit", "card", "ach", "check",
                 "deposit", "withdrawal", "transfer", "recurring", "web", "www", "com", "inc", "llc", "store"}


def key_prefixes(key):
    """Longest-first prefixes of a merchant key: 'home depot store' -> ['home depot store', 'home depot', 'home']."""
    words = key.split()
    out = [" ".join(words[:n]) for n in range(len(words), 0, -1)]
    return [k for k in out if " " in k or (len(k) >= 4 and k not in GENERIC_WORDS)]


def title_case(s):
    return re.sub(r"(^|[\s\-/&(*#])([a-z])", lambda m: m.group(1) + m.group(2).upper(), (s or "").lower())


def short_id(*parts):
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:20]


ALERT_RANK = {"near": 1, "over": 2}
# Fixed bills (mortgage, rent, loans, insurance...) only alert when over budget; reaching it just means the bill was paid.
FIXED_RE = re.compile(r"mortgage|\brent\b|loan|insurance|\btax|childcare|daycare|tuition|\bhoa\b|lease|student", re.I)


def compute_alerts(cats, all_tx, month, alert_at):
    """Categories at or past `alert_at` of their monthly budget: [(cat_id, name, level, pct, spent, budget)]."""
    spent = collections.defaultdict(float)
    for t in all_tx:
        if t.get("type") != "income" and (t.get("date") or "").startswith(month):
            spent[t.get("categoryId")] += float(t.get("amount") or 0)
    out = []
    for cid, c in cats.items():
        budget = float(c.get("budget") or 0)
        if c.get("type") != "expense" or c.get("archived") or c.get("alerts") is False or budget <= 0:
            continue
        pct = spent[cid] / budget
        level = "over" if spent[cid] - budget > 0.004 else "near"
        name = c.get("name", "Category")
        if level == "near" and FIXED_RE.search(name) and "fee" not in name.lower():
            continue
        if pct >= alert_at:
            out.append((cid, name, level, pct, spent[cid], budget))
    return sorted(out, key=lambda a: -a[3])


def add_months(month, n):
    y, m = (int(x) for x in month.split("-"))
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def big_purchases(cats, all_tx, new_tx, prefs, today):
    """Newly synced purchases at or over the user's amount. Skips categories set to 'never', fixed bills, and
    any category where a purchase that size happened in 2 of the last 3 full months (big purchases are normal there).
    Mirrors computeBigPurchases in js/alerts.js."""
    if prefs.get("bigOn") is not True:
        return []
    amount = float(prefs.get("bigAmount") or 0)
    if amount <= 0:
        return []
    months = {add_months(today[:7], -i) for i in (1, 2, 3)}
    big_months = collections.defaultdict(set)
    for t in all_tx:
        d = (t.get("date") or "")[:7]
        if t.get("type") != "income" and float(t.get("amount") or 0) >= amount and d in months:
            big_months[t.get("categoryId")].add(d)
    skip = set()
    for cid, c in cats.items():
        mode = c.get("bigAlerts")
        if mode is True:
            continue
        name = c.get("name", "")
        if mode is False or (FIXED_RE.search(name) and "fee" not in name.lower()) or len(big_months[cid]) >= 2:
            skip.add(cid)
    since = (dt.date.fromisoformat(today) - dt.timedelta(days=3)).isoformat()
    return [t for t in new_tx
            if t.get("type") != "income" and float(t.get("amount") or 0) >= amount
            and (t.get("date") or "") >= since and t.get("categoryId") not in skip]


def send_alerts(hh, cats, all_tx, new_tx, today, db, now=None):
    """Everything that can tell the user something: budget limits, large purchases, bills coming due, subscription
    price changes and the Sunday summary. Each becomes an entry in the app's bell list (idempotent ids) and,
    where it's news, a push notification to every registered device. Logs counts only (public repo)."""
    month = today[:7]
    now = now or dt.datetime.now(TZ)
    now_ms = int(time.time() * 1000)
    prefs_snap = hh.collection("settings").document("budget").get()
    prefs = (prefs_snap.to_dict() or {}) if prefs_snap.exists else {}
    existing = {doc.id: (doc.to_dict() or {}) for doc in hh.collection("notifications").stream()}
    entries = {}     # id -> doc for the bell
    pushes = []      # (title, body, tag)
    writes = []      # (collection, id, doc, merge)
    state_updates = []   # (doc id under bankSync, dict)

    def entry(eid, kind, title, body, link="#/budget", quiet=False):
        if eid not in existing and eid not in entries:
            entries[eid] = {"id": eid, "kind": kind, "title": title, "body": body, "link": link, "quiet": quiet, "ts": now_ms}

    def section(label, fn):
        try:
            fn()
        except Exception as e:  # one failing section must not stop the others
            log(f"{label} failed: {type(e).__name__}")

    # --- budget limits ---
    budget_state = {"month": month, "sent": {}}
    fresh = []

    def budget_limits():
        nonlocal budget_state, fresh
        if prefs.get("alertsOn") is False:
            log("Budget alerts: turned off")
            return
        st = hh.collection("bankSync").document("alerts").get()
        budget_state = (st.to_dict() or {}) if st.exists else {}
        if budget_state.get("month") != month:
            budget_state = {"month": month, "sent": {}}
        current = compute_alerts(cats, all_tx, month, float(prefs.get("alertAt") or 0.8))
        fresh = [a for a in current if ALERT_RANK[a[2]] > ALERT_RANK.get(budget_state["sent"].get(a[0]), 0)]
        log(f"Budget alerts: {len(fresh)} new")
        for a in current:
            over = a[2] == "over"
            entry(f"budget-{month}-{a[0]}-{a[2]}", "over" if over else "budget",
                  f"{a[1]} is over budget" if over else f"{a[1]} is nearing its limit",
                  f"${a[4] - a[5]:,.2f} over its ${a[5]:,.2f} budget" if over else f"At {round(a[3] * 100)}% of its ${a[5]:,.2f} budget, ${a[5] - a[4]:,.2f} left",
                  quiet=a not in fresh)

        def line(a):
            return f"{a[1]} is over its budget" if a[2] == "over" else f"{a[1]} is at {round(a[3] * 100)}% of its budget"
        if len(fresh) == 1:
            pushes.append(("Over budget" if fresh[0][2] == "over" else "Nearing a budget limit", line(fresh[0]), "budget-alert"))
        elif fresh:
            pushes.append((f"{len(fresh)} budget alerts", "; ".join(line(a) for a in fresh[:4]), "budget-alert"))

    section("Budget alerts", budget_limits)

    # --- large purchases ---
    def large():
        bigs = big_purchases(cats, all_tx, new_tx, prefs, today)
        if prefs.get("bigOn") is True:
            log(f"Large purchases: {len(bigs)} new")

        def big_line(t):
            label = t.get("note") or cats.get(t.get("categoryId"), {}).get("name") or "a purchase"
            return f"${float(t['amount']):,.2f} at {label}"
        for t in bigs:
            entry(f"big-{t.get('id')}", "big", "Large purchase", big_line(t))
        if len(bigs) == 1:
            pushes.append(("Large purchase", big_line(bigs[0]), "big-purchase"))
        elif bigs:
            pushes.append((f"{len(bigs)} large purchases", "; ".join(big_line(t) for t in bigs[:4]), "big-purchase"))

    section("Large purchases", large)

    # --- bill reminders (autopay bills are skipped) ---
    def bill_reminders():
        bills = {doc.id: (doc.to_dict() or {}) for doc in hh.collection("bills").stream()}
        rem = hh.collection("bankSync").document("reminders").get()
        sent = dict(((rem.to_dict() or {}).get("sent") or {})) if rem.exists else {}
        due_now = []
        for bid, b in bills.items():
            if b.get("active") is False or b.get("autopay"):
                continue
            ahead_days = int(b.get("remindDays") or 3)
            for due in insights.bill_occurrences(b, today, insights.add_days(today, ahead_days)):
                key = f"{bid}|{due}"
                if key in sent or insights.bill_paid(b, due, all_tx):
                    continue
                n = (dt.date.fromisoformat(due) - dt.date.fromisoformat(today)).days
                when = "today" if n == 0 else "tomorrow" if n == 1 else f"in {n} days"
                amount = float(b.get("amount") or 0)
                entry(f"bill-{bid}-{due}", "bill", f"{b.get('name', 'A bill')} is due {when}", f"${amount:,.2f} due {dt.date.fromisoformat(due).strftime('%A, %B %d').replace(' 0', ' ')}", "#/calendar")
                due_now.append((b.get("name", "A bill"), when, amount))
                sent[key] = today
        log(f"Bill reminders: {len(due_now)}")
        if len(due_now) == 1:
            pushes.append(("Bill due " + due_now[0][1], f"{due_now[0][0]}: ${due_now[0][2]:,.2f}", "bill-reminder"))
        elif due_now:
            pushes.append((f"{len(due_now)} bills due soon", "; ".join(f"{n} {w}" for n, w, _ in due_now[:4]), "bill-reminder"))
        if due_now:
            state_updates.append(("reminders", {"sent": dict(sorted(sent.items(), key=lambda kv: kv[1])[-120:])}))

    section("Bill reminders", bill_reminders)

    # --- Sunday summary (after 3 pm local, once a week) ---
    def weekly():
        if prefs.get("weeklyOn") is False or now.weekday() != 6 or now.hour < 15:
            return
        ref = hh.collection("bankSync").document("weekly").get()
        if ref.exists and (ref.to_dict() or {}).get("last") == today:
            return
        w = insights.week_summary(all_tx, cats, today)
        if not w["count"]:
            return
        parts = []
        if w["delta"] is not None:
            change = f"${abs(w['spent'] - w['prev_spent']):,.0f}" if abs(w["delta"]) > 2 else f"{round(abs(w['delta']) * 100)}%"
            parts.append(f"{'▲' if w['delta'] > 0 else '▼'} {change} vs last week")
        if w["top"]:
            parts.append(f"Top: {w['top'][0]} ${w['top'][1]:,.0f}")
        if w["biggest"]:
            parts.append(f"Biggest: {w['biggest'][0]} ${w['biggest'][1]:,.0f}")
        title, body = f"Your week: ${w['spent']:,.2f} spent", ". ".join(parts)
        entry(f"weekly-{today}", "weekly", title, body, "#/home")
        pushes.append((title, body, "weekly-summary"))
        state_updates.append(("weekly", {"last": today}))
        log("Weekly summary: created")

    section("Weekly summary", weekly)

    # --- subscription tracker ---
    def subscriptions():
        old_docs = {doc.id: (doc.to_dict() or {}) for doc in hh.collection("subscriptions").stream()}
        found = insights.detect_subscriptions(all_tx, cats, today)
        seen, changes = set(), []
        for sub in found:
            sid = "sub_" + short_id(sub["key"])
            seen.add(sid)
            old = old_docs.get(sid, {})
            doc = {**sub, "id": sid, "active": True, "ignored": bool(old.get("ignored")), "notifiedChange": old.get("notifiedChange", ""), "updatedAt": now_ms}
            prev = sub["previous"]
            meaningful = prev is not None and abs(sub["amount"] - prev) >= max(0.5, prev * 0.02)
            recent = bool(sub["changedOn"]) and (dt.date.fromisoformat(today) - dt.date.fromisoformat(sub["changedOn"])).days <= 30
            if meaningful and recent and old.get("notifiedChange") != sub["changedOn"]:
                up = sub["amount"] > prev
                title = f"{sub['name']} went {'up' if up else 'down'}"
                body = f"From ${prev:,.2f} to ${sub['amount']:,.2f} ({sub['frequency']})"
                entry(f"price-{sid}-{sub['changedOn']}", "price", title, body, "#/calendar")
                changes.append((title, body))
                doc["notifiedChange"] = sub["changedOn"]
            writes.append(("subscriptions", sid, doc, False))
        for sid, old in old_docs.items():
            if sid not in seen and old.get("active") is not False:
                writes.append(("subscriptions", sid, {"active": False}, True))
        log(f"Subscriptions: {len(found)} tracked, {len(changes)} price change(s) to announce")
        if len(changes) == 1:
            pushes.append((changes[0][0], changes[0][1], "price-change"))
        elif changes:
            pushes.append((f"{len(changes)} subscription price changes", "; ".join(t for t, _ in changes[:3]), "price-change"))

    section("Subscriptions", subscriptions)

    # --- write bell entries, tidy old ones, then push ---
    if DRY_RUN:
        log(f"Dry run: {len(entries)} bell entries, {len(pushes)} push(es), {len(writes)} subscription writes NOT applied.")
        return
    cutoff = now_ms - 45 * 86400e3
    batch = db.batch()
    ops = 0
    for eid, doc in entries.items():
        batch.set(hh.collection("notifications").document(eid), doc)
        ops += 1
    for eid, old in existing.items():
        if float(old.get("ts") or 0) < cutoff:
            batch.delete(hh.collection("notifications").document(eid))
            ops += 1
    for coll, doc_id, doc, merge in writes:
        batch.set(hh.collection(coll).document(doc_id), doc, merge=merge)
        ops += 1
        if ops >= 380:
            batch.commit()
            batch, ops = db.batch(), 0
    for name, doc in state_updates:
        batch.set(hh.collection("bankSync").document(name), doc, merge=True)
    batch.commit()
    log(f"Notifications logged: {len(entries)}")

    if not pushes:
        return
    devices = [(dev.id, (dev.to_dict() or {}).get("token")) for dev in hh.collection("devices").stream()]
    devices = [(i, t) for i, t in devices if t]
    if not devices:
        log("Alert push skipped (no devices registered).")
        return
    ok = failed = dead = 0
    for title, body, tag in pushes:
        message = messaging.MulticastMessage(
            tokens=[t for _, t in devices],
            data={"title": title, "body": body, "url": "./#/budget", "tag": tag},
            webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "3600"}),
        )
        response = messaging.send_each_for_multicast(message)
        ok += response.success_count
        failed += response.failure_count
        gone = set()
        for (doc_id, _), r in zip(devices, response.responses):
            if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
                hh.collection("devices").document(doc_id).delete()
                gone.add(doc_id)
        dead += len(gone)
        devices = [dv for dv in devices if dv[0] not in gone]
    if fresh:
        for a in fresh:
            budget_state["sent"][a[0]] = a[2]
        hh.collection("bankSync").document("alerts").set(budget_state)
    log(f"Alert push: {len(pushes)} notification(s); {ok} delivered, {failed} failed, {dead} device(s) removed.")


def fetch_simplefin(access_url, start):
    u = urllib.parse.urlsplit(access_url)
    auth = base64.b64encode(
        f"{urllib.parse.unquote(u.username or '')}:{urllib.parse.unquote(u.password or '')}".encode()
    ).decode()
    host = u.hostname + (f":{u.port}" if u.port else "")
    url = f"{u.scheme}://{host}{u.path.rstrip('/')}/accounts?start-date={int(start.timestamp())}"
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}", "User-Agent": "home-hub-sync"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # 403 = access revoked / token bad; 402 = subscription lapsed.
        raise SystemExit(f"SimpleFIN request failed: HTTP {e.code}") from None


def main():
    access_url = os.environ.get("SIMPLEFIN_ACCESS_URL", "").strip()
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not access_url or not sa:
        raise SystemExit("Missing SIMPLEFIN_ACCESS_URL or FIREBASE_SERVICE_ACCOUNT secret. Run tools/setup_bank_sync.py.")

    firebase_admin.initialize_app(credentials.Certificate(json.loads(sa)))
    db = firestore.client()

    hid = os.environ.get("HOUSEHOLD_ID", "").strip()
    if not hid:
        ids = [d.id for d in db.collection("households").stream()]
        if len(ids) != 1:
            raise SystemExit(f"Found {len(ids)} households; set the HOUSEHOLD_ID repo variable.")
        hid = ids[0]
    hh = db.collection("households").document(hid)

    cats = {d.id: d.to_dict() for d in hh.collection("categories").stream()}
    txs = {d.id: d.to_dict() for d in hh.collection("transactions").stream()}
    rules = [d.to_dict() for d in hh.collection("rules").stream()]
    log(f"Loaded {len(cats)} categories, {len(txs)} transactions, {len(rules)} rules")

    cat_by_name = {(c.get("name", "").lower(), c.get("type")): cid for cid, c in cats.items()}
    new_cats = []

    def category_id(name, ctype):
        key = (name.lower(), ctype)
        if key not in cat_by_name:
            cid = "cat_" + short_id(name, ctype)
            icon = {"Paycheck": "💵", "Other income": "🎁", "Mortgage / Rent": "🏠"}.get(name, "📦")
            doc = {"id": cid, "name": name, "type": ctype, "icon": icon, "budget": 0,
                   "order": len(cats) + len(new_cats), "archived": False, "updatedAt": int(time.time() * 1000)}
            new_cats.append(doc)
            cat_by_name[key] = cid
            cats[cid] = doc
        return cat_by_name[key]

    # Learn merchant -> category from everything already categorized (your imported history + edits).
    # Indexed by every prefix so "Chipotle 1234" teaches "chipotle" too.
    learned = collections.defaultdict(collections.Counter)
    for t in txs.values():
        if t.get("categoryId") in cats and not t.get("needsReview"):
            for k in key_prefixes(merchant_key(t.get("note"))):
                learned[k][t["categoryId"]] += 1
    rule_map = {r["match"]: r["categoryId"] for r in rules if r.get("match") and r.get("categoryId") in cats}

    def classify(merchant, full_text, money_in):
        """-> (categoryId, type, needsReview) or None for transfers."""
        if TRANSFER_RE.search(full_text):
            return None
        for rx, name, ctype in NAME_RULES:
            if rx.search(full_text):
                return category_id(name, ctype), ctype, False
        key = merchant_key(merchant)
        words = key.split()
        all_prefixes = [" ".join(words[:n]) for n in range(len(words), 0, -1)]
        prefixes = key_prefixes(key)
        # Your explicit rules win over anything learned (and may be short, like "bp");
        # longer, more specific matches win over shorter ones.
        candidates = [rule_map.get(k) for k in all_prefixes]
        candidates += [learned[k].most_common(1)[0][0] for k in prefixes if learned.get(k)]
        for source in candidates:
            if source and source in cats:
                ctype = cats[source].get("type", "expense")
                if ctype == "income" and not money_in:
                    continue  # money out can't be income; fall through
                return source, ctype, False
        if money_in:
            return category_id("Other income", "income"), "income", True
        return category_id("Other", "expense"), "expense", True

    # Existing transactions from CSV import / manual entry that a bank row might duplicate.
    def signed_out(t):
        a = float(t.get("amount") or 0)
        return a if t.get("type") != "income" else -a

    unlinked = [(tid, t) for tid, t in txs.items() if not t.get("sfId") and t.get("date")]
    linked = {t["sfId"] for t in txs.values() if t.get("sfId")}
    used = set()

    def find_match(date, out):
        d0 = dt.date.fromisoformat(date)
        best = None
        for tid, t in unlinked:
            if tid in used or abs(signed_out(t) - out) > 0.005:
                continue
            gap = abs((dt.date.fromisoformat(t["date"]) - d0).days)
            if gap <= 3 and (best is None or gap < best[0]):
                best = (gap, tid)
        return best[1] if best else None

    start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LOOKBACK_DAYS)
    data = fetch_simplefin(access_url, start)
    errors = [str(e)[:300] for e in data.get("errors") or []]

    writes = []  # (collection, id, dict, merge)
    counts = collections.Counter()
    now_ms = int(time.time() * 1000)

    for acct in data.get("accounts") or []:
        aid = "sf_" + short_id(acct.get("id", ""))
        label = acct.get("name") or "Account"
        writes.append(("accounts", aid, {
            "id": aid,
            "name": label,
            "org": (acct.get("org") or {}).get("name") or "",
            "currency": acct.get("currency") or "USD",
            "balance": float(acct.get("balance") or 0),
            "available": float(acct["available-balance"]) if acct.get("available-balance") not in (None, "") else None,
            "balanceDate": int(acct.get("balance-date") or 0) * 1000,
            "source": "simplefin",
            "updatedAt": now_ms,
        }, False))
        counts["accounts"] += 1

        for tx in acct.get("transactions") or []:
            if tx.get("pending"):
                counts["pending"] += 1
                continue
            sf_id = f"{acct.get('id')}:{tx.get('id')}"
            doc_id = "sf_" + short_id(sf_id)
            if doc_id in txs or sf_id in linked:
                counts["already"] += 1
                continue
            amount = float(tx.get("amount") or 0)  # SimpleFIN: + money in, − money out
            if amount == 0:
                continue
            ts = int(tx.get("transacted_at") or tx.get("posted") or 0)
            date = dt.datetime.fromtimestamp(ts, TZ).date().isoformat()
            desc = tx.get("payee") or tx.get("description") or ""
            out = -amount

            match = find_match(date, out)
            if match:
                used.add(match)
                writes.append(("transactions", match, {"sfId": sf_id, "updatedAt": now_ms}, True))
                counts["matched"] += 1
                continue

            result = classify(desc, f"{desc} {tx.get('description') or ''}", amount > 0)
            if result is None:
                counts["transfers"] += 1
                continue
            cid, ctype, review = result
            writes.append(("transactions", doc_id, {
                "id": doc_id,
                "date": date,
                "type": ctype,
                "amount": round(out if ctype == "expense" else -out, 2),
                "categoryId": cid,
                "note": title_case(desc)[:120],
                "account": label,
                "source": "bank",
                "sfId": sf_id,
                "needsReview": review,
                "createdAt": now_ms,
                "createdBy": "bank sync",
                "updatedAt": now_ms,
            }, False))
            counts["review" if review else "added"] += 1

    for c in new_cats:
        writes.append(("categories", c["id"], c, False))

    writes.append(("bankSync", "status", {
        "lastRun": now_ms,
        "ok": not errors,
        "errors": errors,
        "added": counts["added"] + counts["review"],
        "needsReview": counts["review"],
        "matched": counts["matched"],
        "accounts": counts["accounts"],
    }, False))

    log("Accounts: {accounts} | new: {added} categorized + {review} to review | matched existing: {matched} "
        "| transfers skipped: {transfers} | already synced: {already} | pending skipped: {pending}".format(
            **{k: counts[k] for k in ("accounts", "added", "review", "matched", "transfers", "already", "pending")}))
    if errors:
        log(f"SimpleFIN reported {len(errors)} connection message(s); details are shown in the app.")

    if DRY_RUN:
        log(f"Dry run: {len(writes)} writes NOT applied.")
        try:
            new_tx = [w[2] for w in writes if w[0] == "transactions" and not w[3]]
            send_alerts(hh, cats, list(txs.values()) + new_tx, new_tx, dt.datetime.now(TZ).date().isoformat(), db)
        except Exception as e:
            log(f"Budget alerts failed: {type(e).__name__}")
        return

    for i in range(0, len(writes), 400):
        batch = db.batch()
        for coll, doc_id, doc, merge in writes[i:i + 400]:
            batch.set(hh.collection(coll).document(doc_id), doc, merge=merge)
        batch.commit()
    log(f"Wrote {len(writes)} documents.")

    # Spending-limit alerts. A failure here must never fail the sync itself.
    try:
        new_tx = [w[2] for w in writes if w[0] == "transactions" and not w[3]]
        send_alerts(hh, cats, list(txs.values()) + new_tx, new_tx, dt.datetime.now(TZ).date().isoformat(), db)
    except Exception as e:
        log(f"Budget alerts failed: {type(e).__name__}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # keep tracebacks out of public logs; they could include data
        log(f"Sync failed: {type(e).__name__}")
        sys.exit(1)

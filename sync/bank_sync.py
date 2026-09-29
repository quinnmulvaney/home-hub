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
FIXED_RE = re.compile(r"mortgage|rent|loan|insurance|tax|childcare|daycare|tuition|hoa|lease|student", re.I)


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


def send_alerts(hh, cats, all_tx, month):
    """Push a notification to every registered device when a category newly crosses its limit."""
    settings = hh.collection("settings").document("budget").get()
    prefs = (settings.to_dict() or {}) if settings.exists else {}
    if prefs.get("alertsOn") is False:
        log("Budget alerts: turned off")
        return
    alert_at = float(prefs.get("alertAt") or 0.8)
    state_ref = hh.collection("bankSync").document("alerts")
    state = state_ref.get()
    sent = (state.to_dict() or {}) if state.exists else {}
    if sent.get("month") != month:
        sent = {"month": month, "sent": {}}
    fresh = [a for a in compute_alerts(cats, all_tx, month, alert_at)
             if ALERT_RANK[a[2]] > ALERT_RANK.get(sent["sent"].get(a[0]), 0)]
    log(f"Budget alerts: {len(fresh)} new")
    if not fresh:
        return
    devices = [(d.id, (d.to_dict() or {}).get("token")) for d in hh.collection("devices").stream()]
    devices = [(i, t) for i, t in devices if t]
    if DRY_RUN or not devices:
        log(f"Alert push skipped ({'dry run' if DRY_RUN else 'no devices registered'}).")
        return

    def line(a):
        return f"{a[1]} is over its budget" if a[2] == "over" else f"{a[1]} is at {round(a[3] * 100)}% of its budget"
    if len(fresh) == 1:
        title = "Over budget" if fresh[0][2] == "over" else "Nearing a budget limit"
        body = line(fresh[0])
    else:
        title = f"{len(fresh)} budget alerts"
        body = "; ".join(line(a) for a in fresh[:4])
    message = messaging.MulticastMessage(
        tokens=[t for _, t in devices],
        data={"title": title, "body": body, "url": "./#/budget", "tag": "budget-alert"},
        webpush=messaging.WebpushConfig(headers={"Urgency": "high", "TTL": "3600"}),
    )
    response = messaging.send_each_for_multicast(message)
    dead = 0
    for (doc_id, _), r in zip(devices, response.responses):
        if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
            hh.collection("devices").document(doc_id).delete()
            dead += 1
    for a in fresh:
        sent["sent"][a[0]] = a[2]
    state_ref.set(sent)
    log(f"Alert push: sent to {response.success_count} device(s), {response.failure_count} failed, {dead} removed.")


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
            send_alerts(hh, cats, list(txs.values()) + new_tx, dt.datetime.now(TZ).strftime("%Y-%m"))
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
        send_alerts(hh, cats, list(txs.values()) + new_tx, dt.datetime.now(TZ).strftime("%Y-%m"))
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

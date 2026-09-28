"""Read-only health check of the household data: completeness and duplicates.

The repo is PUBLIC: this prints counts, category names and ✓/✗ only. Never amounts or merchants.

Env:
  FIREBASE_SERVICE_ACCOUNT  secret
  HOUSEHOLD_ID              optional (auto-detected when there is one household)
  AUDIT_EXPECTED            optional secret: {"count": N, "since": "YYYY-MM-DD", "byCat": {name: cents}}
                            expected totals for imported transactions, compared as ✓/✗ only
"""
import collections
import datetime as dt
import json
import os

import firebase_admin
from firebase_admin import credentials, firestore


def main():
    firebase_admin.initialize_app(credentials.Certificate(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])))
    db = firestore.client()
    households = [d.id for d in db.collection("households").stream()]
    print(f"Households: {len(households)}")
    hid = os.environ.get("HOUSEHOLD_ID", "").strip() or (households[0] if len(households) == 1 else "")
    if not hid:
        raise SystemExit("More than one household; set HOUSEHOLD_ID.")
    hh = db.collection("households").document(hid)
    members = len((hh.get().to_dict() or {}).get("members", []))
    print(f"Members in household: {members}")

    cats = {d.id: d.to_dict() for d in hh.collection("categories").stream()}
    txs = {d.id: d.to_dict() for d in hh.collection("transactions").stream()}
    print(f"Categories: {len(cats)} | Transactions: {len(txs)}")

    by_source = collections.Counter(t.get("source") or "manual" for t in txs.values())
    print("By source: " + ", ".join(f"{k}={v}" for k, v in sorted(by_source.items())))
    months = collections.Counter((t.get("date") or "????-??")[:7] for t in txs.values())
    print("By month: " + ", ".join(f"{m}={n}" for m, n in sorted(months.items())))

    # Duplicate categories (same name + type).
    names = collections.defaultdict(list)
    for cid, c in cats.items():
        names[(c.get("name", "").strip().lower(), c.get("type"))].append(cid)
    dup_cats = {k: v for k, v in names.items() if len(v) > 1}
    print(f"Duplicate categories: {len(dup_cats)}" +
          ("" if not dup_cats else " -> " + ", ".join(f"{cats[v[0]]['name']} x{len(v)}" for v in dup_cats.values())))
    orphans = sum(1 for t in txs.values() if t.get("categoryId") not in cats)
    print(f"Transactions whose category is missing: {orphans}")

    # Exact duplicates: same date, type, amount, merchant/note and account.
    exact = collections.defaultdict(list)
    for tid, t in txs.items():
        key = (t.get("date"), t.get("type"), round(float(t.get("amount") or 0), 2),
               (t.get("note") or "").strip().lower(), t.get("account") or "")
        exact[key].append(tid)
    groups = [ids for ids in exact.values() if len(ids) > 1]
    combos = collections.Counter("+".join(sorted(txs[i].get("source") or "manual" for i in ids)) for ids in groups)
    print(f"Exact-duplicate groups: {len(groups)} ({sum(len(g) - 1 for g in groups)} extra rows)" +
          ("" if not combos else " by source: " + ", ".join(f"{k}={v}" for k, v in combos.items())))

    # Near duplicates across sources: same amount/type within 3 days, different source (e.g. typed in AND imported).
    in_exact = {i for g in groups for i in g}
    by_amt = collections.defaultdict(list)
    for tid, t in txs.items():
        if tid not in in_exact and t.get("date"):
            by_amt[(t.get("type"), round(float(t.get("amount") or 0), 2))].append(tid)
    near = 0
    for ids in by_amt.values():
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                ta, tb = txs[a], txs[b]
                if (ta.get("source") or "manual") == (tb.get("source") or "manual"):
                    continue
                if abs((dt.date.fromisoformat(ta["date"]) - dt.date.fromisoformat(tb["date"])).days) <= 3:
                    near += 1
    print(f"Possible cross-source duplicates (same amount, ≤3 days apart): {near}")

    # Completeness vs. the CSV (✓/✗ only).
    expected = os.environ.get("AUDIT_EXPECTED", "").strip()
    if expected:
        exp = json.loads(expected)
        imported = [t for t in txs.values() if t.get("source") == "import" and t.get("date", "") >= exp.get("since", "")]
        got = collections.Counter()
        for t in imported:
            got[cats.get(t.get("categoryId"), {}).get("name", "?")] += round(float(t.get("amount") or 0) * 100)
        print(f"Imported count matches CSV: {'✓' if len(imported) == exp['count'] else '✗ off by %d' % (len(imported) - exp['count'])}")
        for name in sorted(set(exp["byCat"]) | set(got)):
            ok = got.get(name, 0) == exp["byCat"].get(name, 0)
            print(f"  {'✓' if ok else '✗'} {name}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # no tracebacks in public logs
        print(f"Audit failed: {type(e).__name__}")
        raise SystemExit(1)

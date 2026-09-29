"""Diagnostic: which fields does the bank feed provide? Prints FIELD NAMES and COUNTS ONLY.
The repo is public, so this never prints values, amounts, merchants, account names or numbers."""
import collections
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bank_sync  # noqa: E402  (reuses fetch_simplefin)


def main():
    start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=90)
    data = bank_sync.fetch_simplefin(os.environ["SIMPLEFIN_ACCESS_URL"].strip(), start)
    accounts = data.get("accounts") or []
    print(f"Accounts: {len(accounts)}")
    print("Top-level response keys:", sorted(data.keys()))
    acct_keys, tx_keys, extra_keys = collections.Counter(), collections.Counter(), collections.Counter()
    org_keys = collections.Counter()
    per_acct = []
    for a in accounts:
        acct_keys.update(a.keys())
        org_keys.update((a.get("org") or {}).keys())
        txs = a.get("transactions") or []
        per_acct.append(len(txs))
        for t in txs:
            tx_keys.update(t.keys())
            if isinstance(t.get("extra"), dict):
                extra_keys.update(t["extra"].keys())
    print("Account fields:", sorted(acct_keys))
    print("Org fields:", sorted(org_keys))
    print("Transaction fields (count of transactions having each):", dict(sorted(tx_keys.items())))
    print("Fields inside 'extra':", dict(sorted(extra_keys.items())) or "none")
    print("Transactions per account:", per_acct)
    # Does anything in the feed identify WHO made a purchase? Look only for field names that could.
    person_like = [k for k in list(tx_keys) + list(extra_keys) if any(w in k.lower() for w in ("holder", "owner", "user", "member", "person", "cardholder", "name", "card"))]
    print("Person-like field names:", person_like or "none")


if __name__ == "__main__":
    main()

"""Pure logic for the bank-sync job: subscription detection, bill schedules, weekly summary.
No network, no Firebase: everything takes plain dicts, so it can be tested on its own.
Mirrors js/stats.js (bills, weekly summary) and js/merchant.js (merchant keys)."""
import collections
import datetime as dt
import re
import statistics

# Everyday spending that repeats without being a subscription.
NOT_SUBSCRIPTIONS = re.compile(r"dining|restaurant|coffee|takeout|fuel|gas\b|shopping|cash|grocer", re.I)


def merchant_key(text):
    s = (text or "").lower()
    s = re.sub(r"^(sq \*|sq\*|tst\* ?|sp \*?|pp\*|paypal \*|dd \*|in \*)", "", s)
    s = re.sub(r"[^a-z ]+", " ", s)
    return " ".join([w for w in s.split() if len(w) > 1][:3])


def title_case(s):
    return re.sub(r"(^|[\s\-/&(*#])([a-z])", lambda m: m.group(1) + m.group(2).upper(), (s or "").lower())


def d(iso):
    return dt.date.fromisoformat(iso)


def add_days(iso, n):
    return (d(iso) + dt.timedelta(days=n)).isoformat()


def add_months(iso, n):
    y, m = d(iso).year, d(iso).month
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


# ---------- subscriptions ----------

def detect_subscriptions(all_tx, cats, today):
    """Charges that repeat on a regular schedule at a fixed price (monthly, quarterly or yearly).
    Returns a list of dicts with the current price, the price before it, and when it changed."""
    groups = collections.defaultdict(list)
    for t in all_tx:
        amount = float(t.get("amount") or 0)
        date = t.get("date") or ""
        if t.get("type") == "income" or amount <= 0 or not date:
            continue
        if NOT_SUBSCRIPTIONS.search((cats.get(t.get("categoryId")) or {}).get("name", "")):
            continue
        key = " ".join(merchant_key(t.get("note")).split()[:2])
        if len(key) < 3:
            continue
        groups[key].append((date, amount, t.get("note") or key))

    found = []
    for key, items in groups.items():
        items.sort()
        if len(items) < 3:
            continue
        dates = [d(x[0]) for x in items]
        amounts = [x[1] for x in items]
        gaps = [(b - a).days for a, b in zip(dates, dates[1:])]
        if not gaps:
            continue
        med = statistics.median(gaps)
        if 26 <= med <= 35:
            freq, per_year = "monthly", 12
        elif 84 <= med <= 100:
            freq, per_year = "quarterly", 4
        elif 350 <= med <= 380:
            freq, per_year = "yearly", 1
        else:
            continue
        regular = sum(1 for g in gaps if abs(g - med) <= max(5, med * 0.2)) / len(gaps)
        if regular < 0.6:
            continue
        changes = sum(1 for a, b in zip(amounts, amounts[1:]) if abs(b - a) > 0.005)
        if changes > max(1, len(amounts) // 3):
            continue                      # amount moves every time: a variable bill, not a fixed price
        last = dates[-1]
        if (d(today) - last).days > med * 1.7 + 7:
            continue                      # hasn't charged in a while: probably cancelled
        runs = []
        for date, amount, _ in items:
            if not runs or abs(amount - runs[-1]["amount"]) > 0.005:
                runs.append({"amount": round(amount, 2), "since": date})
        previous = runs[-2]["amount"] if len(runs) > 1 else None
        latest_note = items[-1][2]
        found.append({
            "key": key,
            "name": title_case(latest_note)[:60],
            "frequency": freq,
            "amount": round(amounts[-1], 2),
            "previous": previous,
            "changedOn": runs[-1]["since"] if previous is not None else "",
            "lastDate": items[-1][0],
            "nextDate": (last + dt.timedelta(days=round(med))).isoformat(),
            "count": len(items),
            "monthly": round(amounts[-1] * per_year / 12, 2),
            "runs": runs[-6:],
        })
    return sorted(found, key=lambda s: -s["monthly"])


# ---------- bills ----------

def bill_occurrences(bill, start, end):
    """Due dates (ISO) of a bill between start and end, inclusive."""
    out = []
    freq = bill.get("freq") or "monthly"
    anchor = bill.get("startDate") or ""
    if freq == "monthly":
        day = int(bill.get("day") or (anchor[8:10] or 1))
        y, m = d(start).year, d(start).month
        ey, em = d(end).year, d(end).month
        while (y, m) <= (ey, em):
            last_day = (dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.timedelta(days=1)).day
            due = dt.date(y, m, min(day, last_day)).isoformat()
            if start <= due <= end and due >= (anchor or "0000-00-00"):
                out.append(due)
            m += 1
            if m > 12:
                m, y = 1, y + 1
    elif freq in ("weekly", "biweekly") and anchor:
        step = 7 if freq == "weekly" else 14
        cur = anchor
        if cur < start:
            cur = add_days(anchor, -(-((d(start) - d(anchor)).days) // step) * step)
        while cur <= end:
            if cur >= start:
                out.append(cur)
            cur = add_days(cur, step)
    elif freq == "yearly" and anchor:
        for y in range(d(start).year, d(end).year + 1):
            due = f"{y}-{anchor[5:7]}-{anchor[8:10]}"
            if start <= due <= end and due >= anchor:
                out.append(due)
    return out


def bill_paid(bill, due, all_tx):
    if (bill.get("paid") or {}).get(due):
        return True
    key = merchant_key(bill.get("match") or bill.get("name"))
    if len(key) < 3:
        return False
    lo, hi = add_days(due, -5), add_days(due, 7)
    amount = float(bill.get("amount") or 0)
    tol = max(3.0, amount * 0.25)
    for t in all_tx:
        date = t.get("date") or ""
        a = float(t.get("amount") or 0)
        if t.get("type") == "income" or a <= 0 or not (lo <= date <= hi):
            continue
        k = merchant_key(t.get("note"))
        if len(k) >= 3 and (k.startswith(key) or key.startswith(k)) and abs(a - amount) <= tol:
            return True
    return False


# ---------- weekly summary ----------

def week_summary(all_tx, cats, today):
    """Monday through `today` compared with the same span the week before."""
    dow = d(today).weekday()  # Monday = 0
    start = add_days(today, -dow)
    prev_start = add_days(start, -7)
    prev_end = add_days(prev_start, dow)
    spend = [t for t in all_tx if t.get("type") != "income" and t.get("date")]
    week = [t for t in spend if start <= t["date"] <= today]
    prev = [t for t in spend if prev_start <= t["date"] <= prev_end]
    total = round(sum(float(t.get("amount") or 0) for t in week), 2)
    prev_total = round(sum(float(t.get("amount") or 0) for t in prev), 2)
    by_cat = collections.defaultdict(float)
    for t in week:
        by_cat[t.get("categoryId")] += float(t.get("amount") or 0)
    top = max(by_cat.items(), key=lambda kv: kv[1]) if by_cat else None
    big = max((t for t in week if float(t.get("amount") or 0) > 0), key=lambda t: float(t["amount"]), default=None)
    return {
        "start": start, "spent": total, "prev_spent": prev_total, "count": len(week),
        "delta": (total - prev_total) / prev_total if prev_total > 0 else None,
        "top": ((cats.get(top[0]) or {}).get("name", "Uncategorized"), round(top[1], 2)) if top else None,
        "biggest": ((big.get("note") or "a purchase"), round(float(big["amount"]), 2)) if big else None,
    }

"""Pure logic for the bank-sync job: subscription detection, bill schedules, weekly summary.
No network, no Firebase: everything takes plain dicts, so it can be tested on its own.
Mirrors js/stats.js (bills, weekly summary) and js/merchant.js (merchant keys)."""
import calendar as _calendar
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


# ---------- calendar events (mirror of js/events.js) ----------

def _dow(iso):
    return (d(iso).weekday() + 1) % 7          # Sunday = 0, like JavaScript


def monday_of(iso):
    return add_days(iso, -d(iso).weekday())


def event_occurrences(ev, start, end):
    """[(date, index)] for every occurrence of `ev` from start to end inclusive. `index` counts occurrences since the
    first one (used by take-turns rotation)."""
    out = []
    first = ev.get("date")
    if not first or end < first:
        return out
    until = ev.get("until") or "9999-12-31"
    last = min(end, until)
    every = max(1, int(ev.get("every") or 1))
    skip = ev.get("exceptions") or {}

    def push(date, index):
        if start <= date <= last and not skip.get(date):
            out.append((date, index))

    repeat = ev.get("repeat") or "none"
    if repeat == "none":
        stop = ev["endDate"] if (ev.get("endDate") or "") > first else first
        cur = max(first, start)
        while cur <= stop and cur <= end:
            if not skip.get(cur):
                out.append((cur, 0))
            cur = add_days(cur, 1)
    elif repeat == "daily":
        cur, i = first, 0
        while cur <= last:
            push(cur, i)
            cur, i = add_days(cur, every), i + 1
    elif repeat == "weekly":
        days = ev.get("weekdays") or [_dow(first)]
        first_monday = d(monday_of(first))
        cur, index = first, 0
        while cur <= last and index < 5000:
            if _dow(cur) in days and round((d(monday_of(cur)) - first_monday).days / 7) % every == 0:
                push(cur, index)
                index += 1
            cur = add_days(cur, 1)
    elif repeat in ("monthly", "yearly"):
        s0 = d(first)
        step = every if repeat == "monthly" else 12 * every
        for i in range(1200):
            total = (s0.month - 1) + i * step
            y, m = s0.year + total // 12, total % 12 + 1
            due = dt.date(y, m, min(s0.day, _calendar.monthrange(y, m)[1])).isoformat()
            if due > last:
                break
            push(due, i)
    return out


def assignees_for(ev, date, index=0):
    swap = (ev.get("overrides") or {}).get(date)
    if swap and swap.get("assignees") is not None:
        return list(swap["assignees"])
    rot = ev.get("rotation") or {}
    order = rot.get("order") or []
    if order:
        if rot.get("by") == "week":
            i = (d(monday_of(date)) - d(monday_of(ev["date"]))).days // 7
        else:
            i = index
        return [order[i % len(order)]]
    return list(ev.get("assignees") or [])


def involves(assignees, cal, uid):
    if assignees:
        return uid in assignees
    members = (cal or {}).get("members") or []
    return not cal or not members or uid in members


def fmt_time(hhmm):
    if not hhmm:
        return ""
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def morning_summary(uid, name, today, calendars, events, tasks, statuses, people):
    """Things worth knowing this morning for one person. Calendars marked hideFromDigest (work) are left out.
    Returns (title, body, count) or None when there's nothing to say."""
    items = []
    timed = []
    for ev in events:
        cal = calendars.get(ev.get("calendarId"))
        if (cal or {}).get("hideFromDigest"):
            continue
        for date, idx in event_occurrences(ev, today, today):
            who = assignees_for(ev, date, idx)
            if not involves(who, cal, uid):
                continue
            if (ev.get("done") or {}).get(date):
                continue
            turn = " (your turn)" if (ev.get("rotation") or {}).get("order") and who[:1] == [uid] else ""
            label = f"{fmt_time(ev.get('start'))} {ev.get('title', 'Event')}{turn}".strip()
            timed.append((ev.get("start") or "00:00", label))
    items += [label for _, label in sorted(timed)]
    for t in tasks:
        if t.get("assignee") == uid and t.get("status") != "done" and (not t.get("due") or t["due"] <= today):
            frm = f" (from {people.get(t.get('assignedBy'), {}).get('name', 'someone')})" if t.get("status") == "pending" and t.get("assignedBy") else ""
            items.append(f"To do: {t.get('title', 'Task')}{frm}")
    count = len(items)
    others = [f"{people.get(s['uid'], {}).get('name', 'Someone')}: {s['text']}" for s in statuses if s.get("date") == today and s.get("uid") != uid and s.get("text")]
    if not count:
        return None
    title = f"Good morning, {name}" if name else "Good morning"
    body = " · ".join(items[:5]) + (f" · +{count - 5} more" if count > 5 else "")
    if others:
        body += "  |  " + "; ".join(others[:2])
    return title, body, count

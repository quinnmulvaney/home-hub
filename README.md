# Home Hub

A household app (budget now; calendar, shopping lists and more later) that installs on
**Windows and Android** and **syncs between them** — all on free tiers.

- **App type:** Progressive Web App (PWA) — one codebase, installs like a native app, works offline.
- **Sync:** Firebase (Google sign-in + Firestore database), free "Spark" plan. No credit card.
- **Hosting:** GitHub Pages, free.
- **No build step:** plain HTML/CSS/JS. Edit a file, refresh.

Without sync set up, the app still works fully — data just stays on that one device.

---

## 1. Try it locally

From this folder:

```bash
python -m http.server 8123
```

Open http://localhost:8123. (Opening `index.html` directly as a file won't work — it needs a server.)

## 2. Turn on sync (Firebase, ~10 minutes, free)

1. Go to https://console.firebase.google.com → **Create a project** (name it e.g. `home-hub`; you can turn Google Analytics off).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
3. **Build → Firestore Database → Create database** → pick a location near you → **Start in production mode**.
4. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), click **Publish**.
5. **Project settings** (gear icon) → **General** → *Your apps* → click the **Web `</>`** icon → register the app (no hosting needed) → copy the `firebaseConfig` values into [`js/firebase-config.js`](js/firebase-config.js).
6. Reload the app → **Settings → Sign in with Google**. If you already entered data, it offers to copy it into the cloud.

`localhost` is allowed for sign-in by default. When you host the app (step 3), add that domain too:
**Authentication → Settings → Authorized domains → Add domain** → `YOUR-GITHUB-USERNAME.github.io`.

> The values in `firebase-config.js` are not secrets — Google designs them to be public.
> Your data is protected by the Firestore rules (only household members can read or write).

## 3. Host it for free (GitHub Pages)

Your phone needs to reach the app over HTTPS, so put it online:

1. Create a free account at https://github.com and a new **public** repository called `home-hub`.
2. From this folder:

   ```bash
   git init -b main
   git add .
   git commit -m "Home Hub"
   git remote add origin https://github.com/YOUR-GITHUB-USERNAME/home-hub.git
   git push -u origin main
   ```

3. On GitHub: repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root → Save.**
4. After a minute it's live at `https://YOUR-GITHUB-USERNAME.github.io/home-hub/`.
5. Add `YOUR-GITHUB-USERNAME.github.io` to Firebase's authorized domains (see above).

To update later: edit files, then `git add . && git commit -m "update" && git push`. Installed apps pick up the change on next launch.

## 4. Install it

- **Windows (Edge or Chrome):** open the site → click the install icon (⊕) at the right end of the address bar (or ⋯ → Apps → Install). It gets a Start menu entry and its own window.
- **Android (Chrome):** open the site → ⋮ menu → **Add to Home screen → Install**.

Sign in with the same Google account on both and everything stays in sync — including changes made offline, which upload when you're back online.

## 5. Share with your household

Settings → Household → **Copy** the invite code and send it to them. They install the app, sign in with *their* Google account, and paste the code under **Join a different household**. You'll both see and edit the same data live.

---

## Automatic bank sync (SimpleFIN, $15/year)

A GitHub Action ([bank-sync.yml](.github/workflows/bank-sync.yml)) runs 3× a day, pulls new transactions and
balances from [SimpleFIN Bridge](https://beta-bridge.simplefin.org), and writes them into your household.
Card payments and transfers between your own accounts are skipped; rows you already imported or typed in are
linked instead of duplicated; merchants are categorized from your history and your "always" rules, and anything
unknown lands in **Needs review**. Logs show counts only (the repo is public).

One-time setup (from this folder): generate a Firebase key (Project settings → Service accounts →
Generate new private key), then run `python tools/setup_bank_sync.py` and follow the prompts.
Run it manually any time: GitHub → Actions → Bank sync → Run workflow.

## What's in the budget

- **Overview:** income, spent, left to spend, and net for the month; a progress bar per category against its monthly budget (with a "today" marker showing how far through the month you are); 6‑month income vs. spending chart.
- **Transactions:** add/edit/delete, search, filter by category, grouped by day.
- **Categories:** starter set of common household categories; set monthly budgets, add your own with emoji icons, archive old ones (history is kept).
- **Settings:** sync & household, currency, JSON backup/restore, install button.

## Free tier limits (you won't hit these)

Firestore free: 1 GiB storage, 50,000 reads and 20,000 writes per day. A household budget uses a tiny fraction of that.

## Project layout

```
index.html              app shell
css/app.css             all styles (light + dark)
js/app.js               navigation; list of modules
js/store.js             data layer: local storage or Firestore, same API for every module
js/util.js              formatting, dates, modal/toast helpers
js/modules/budget.js    the budget feature
js/modules/settings.js  sync, household, backup, install
js/modules/placeholder.js  "coming soon" pages
js/firebase-config.js   your Firebase keys go here
firestore.rules         database security rules
sw.js                   offline support
```

**Adding a feature** (e.g. shopping list): create `js/modules/shopping.js` exporting
`{ id, title, icon, render(el) }`, use `store.subscribe('shoppingItems', cb)` / `store.add(...)`
for data (sync comes for free), and swap it into the `modules` list in `js/app.js`. Add the new
file to the `SHELL` list in `sw.js` and bump its `CACHE` version.

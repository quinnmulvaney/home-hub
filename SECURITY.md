# Security notes

This repository is **public**, and so are its GitHub Pages site and its workflow logs. Anyone can read them.
Your financial data lives in Firebase (Firestore), not here.

## What is public (and fine)
- The source code, and the Firebase *web* config in `js/firebase-config.js` (API key, project id, app id) plus the
  push **public** key. These identify the project but grant no access; access is decided by `firestore.rules`.
- Demo data (`js/demo.js`) is entirely fictional.

## What must never be committed or logged
- Service-account key, SimpleFIN access URL, household id, invite codes, transaction data, account numbers.
- All of these are kept in **encrypted GitHub secrets** (masked in logs). Never pass them through `vars.*`
  (plain repository variables are printed in public logs) and never `print` them from a script.
- The sync scripts print counts only.

## How access works
- Only people whose Google account is a **member** of a household can read or write its data (`firestore.rules`).
- The household id is not a password. To add someone, a member creates an **invite code**: random, single-use, expires
  in 3 days. Send it privately.
- Optional hardening in `firestore.rules`: limit sign-in to specific Google accounts (put the addresses in the console,
  not in this public file).

## Checklist (Google/GitHub consoles)
1. Publish `firestore.rules` after any change (Firestore → Rules).
2. GitHub: two-factor authentication on, Dependabot alerts on, branch protection on `main`.
3. Google Cloud → Credentials: restrict the browser API key to `quinnmulvaney.github.io/*` and `localhost`.
4. Firebase → Authentication: only the Google provider enabled; consider turning off new sign-ups.
5. Use a least-privilege service account for the sync job; rotate its key from time to time.
6. Consider Firebase App Check, and moving hosting so the repository can be private.

## Reporting a problem
This is a private household project. If you find a vulnerability in the public code, please open a private
security advisory on the repository.

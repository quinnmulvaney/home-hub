"""One-time setup for automatic bank sync. Run from the home-hub folder:

    python tools/setup_bank_sync.py

1. Claims your SimpleFIN setup token and stores the resulting access URL as an encrypted GitHub secret.
2. Uploads your Firebase service-account key as an encrypted GitHub secret (and offers to delete the file).
3. Starts the first sync.
Nothing secret is printed.
"""
import base64
import getpass
import glob
import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request

REPO = "quinnmulvaney/home-hub"
PROJECT_ID = "mulvaney-family-app"
GH = shutil.which("gh") or r"C:\Program Files\GitHub CLI\gh.exe"


def set_secret(name, value):
    subprocess.run([GH, "secret", "set", name, "--repo", REPO], input=value.encode(), check=True,
                   stdout=subprocess.DEVNULL)


def existing_secrets():
    out = subprocess.run([GH, "secret", "list", "--repo", REPO, "--json", "name"], capture_output=True, text=True)
    try:
        return {s["name"] for s in json.loads(out.stdout or "[]")}
    except json.JSONDecodeError:
        return set()


def setup_simplefin():
    token = getpass.getpass("Paste your SimpleFIN setup token (typing is hidden), then press Enter: ").strip()
    if not token:
        print("  Skipped.")
        return False
    try:
        claim_url = base64.b64decode(token + "=" * (-len(token) % 4)).decode().strip()
    except Exception:
        claim_url = ""
    if not claim_url.startswith("https://") or "/claim/" not in claim_url:
        print("  That doesn't look like a SimpleFIN setup token. Copy it again from SimpleFIN.")
        return False
    req = urllib.request.Request(claim_url, data=b"", method="POST", headers={"Content-Length": "0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            access_url = r.read().decode().strip()
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print("  SimpleFIN says this token was already used or is invalid.")
            print("  In SimpleFIN, delete that app connection, create a new one, and run this again.")
        else:
            print(f"  SimpleFIN returned HTTP {e.code}. Try again in a minute.")
        return False
    if not access_url.startswith("https://"):
        print("  Unexpected response from SimpleFIN. Nothing was saved.")
        return False
    set_secret("SIMPLEFIN_ACCESS_URL", access_url)
    print("  ✓ SimpleFIN connected. Stored as the encrypted GitHub secret SIMPLEFIN_ACCESS_URL.")
    return True


def setup_firebase():
    downloads = os.path.join(os.path.expanduser("~"), "Downloads")
    found = sorted(glob.glob(os.path.join(downloads, f"{PROJECT_ID}-firebase-adminsdk-*.json")), key=os.path.getmtime)
    default = found[-1] if found else ""
    prompt = f"Path to the Firebase key file [{os.path.basename(default)}]: " if default else "Path to the Firebase key file: "
    path = input(prompt).strip().strip('"') or default
    if not path or not os.path.isfile(path):
        print("  File not found. In Firebase: Project settings > Service accounts > Generate new private key.")
        return False
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        key = json.loads(raw)
    except json.JSONDecodeError:
        print("  That file isn't valid JSON.")
        return False
    if key.get("type") != "service_account" or key.get("project_id") != PROJECT_ID:
        print(f"  That isn't a service-account key for {PROJECT_ID}.")
        return False
    set_secret("FIREBASE_SERVICE_ACCOUNT", raw)
    print("  ✓ Stored as the encrypted GitHub secret FIREBASE_SERVICE_ACCOUNT.")
    if input("  Delete the downloaded key file now? It's no longer needed. [Y/n]: ").strip().lower() in ("", "y", "yes"):
        os.remove(path)
        print("  ✓ Deleted.")
    return True


def main():
    have = existing_secrets()
    print("\n== Step 1 of 2: SimpleFIN ==")
    if "SIMPLEFIN_ACCESS_URL" in have and input("  Already set up. Replace it? [y/N]: ").strip().lower() != "y":
        ok1 = True
    else:
        ok1 = setup_simplefin()

    print("\n== Step 2 of 2: Firebase key ==")
    if "FIREBASE_SERVICE_ACCOUNT" in have and input("  Already set up. Replace it? [y/N]: ").strip().lower() != "y":
        ok2 = True
    else:
        ok2 = setup_firebase()

    if ok1 and ok2:
        # First run is a dry run: it reports what it *would* do so it can be checked before anything is written.
        subprocess.run([GH, "workflow", "run", "bank-sync.yml", "--repo", REPO,
                        "-f", "lookback_days=30", "-f", "dry_run=true"], check=False)
        print("\nAll set. A test run (writes nothing) is starting now; it takes about a minute.")
        print(f"Progress: https://github.com/{REPO}/actions/workflows/bank-sync.yml")
    else:
        print("\nSetup isn't finished yet. Fix the step above and run this again.")


if __name__ == "__main__":
    main()

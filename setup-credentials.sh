#!/usr/bin/env bash
# Stores the Moodle site URL, login and password in .secrets/moodle.json (mode 600).
set -euo pipefail

cd "$(dirname "$0")" || exit 1
mkdir -p .secrets
chmod 700 .secrets 2>/dev/null || true

BASE_URL="${MOODLE_BASE_URL:-}"
read -r -p "Moodle site URL${BASE_URL:+ [$BASE_URL]}: " INPUT
BASE_URL="${INPUT:-$BASE_URL}"
if [ -z "$BASE_URL" ]; then
  echo "A Moodle site URL is required (for example https://moodle.yourschool.edu)." >&2
  exit 1
fi

read -r -p "Moodle username: " MOODLE_USER
read -r -s -p "Password: " MOODLE_PASS
echo

node -e '
const fs = require("node:fs");
const [baseUrl, user, pass] = process.argv.slice(1);
const path = ".secrets/moodle.json";
const data = { username: user, password: pass, baseUrl: baseUrl.replace(/\/+$/, "") };
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(path, 0o600);
' "$BASE_URL" "$MOODLE_USER" "$MOODLE_PASS"

echo "Saved: $(pwd)/.secrets/moodle.json (mode 600)"
echo "Check: node cli.mjs login"

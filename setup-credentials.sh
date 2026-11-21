#!/usr/bin/env bash
# Stores the Moodle site URL, login and password as an encrypted vault - never in plaintext.
# The prompts (site, login, password without echo) live in cli.mjs so every platform behaves
# the same way. Extra arguments are passed through (--base-url, --username, --stdin).
set -euo pipefail

cd "$(dirname "$0")" || exit 1
exec node cli.mjs vault init "$@"

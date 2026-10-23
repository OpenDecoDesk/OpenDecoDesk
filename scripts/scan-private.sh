#!/usr/bin/env bash
# Looks for things that must never be in this repository.
#   1. Secrets: live API keys, webhook secrets, private keys, Cloudflare ids. Always fails the run.
#   2. Strings that tie the code to one particular business (names, domains, addresses). Your own
#      list, in scripts/scan-private.words (one extended-regex per line; start from
#      scan-private.words.example). That file is ignored by git — a list of private words is itself
#      private — so this check runs where the list exists and is skipped where it doesn't (CI).
#      Reported; with --strict they fail too.
# It reads the tracked files as they are now. It does not read history: before a first push, check
# the commits you are about to publish as well.
# Usage: bash scripts/scan-private.sh [--strict]
set -uo pipefail
cd "$(dirname "$0")/.."
STRICT=0; [ "${1:-}" = "--strict" ] && STRICT=1
# The files to read, NUL-separated so a name with a space or a quote in it is still read.
files() {
  { git ls-files -z 2>/dev/null || find . -type f -not -path './node_modules/*' -not -path './.git/*' -print0; } \
    | grep -zvE '^(\./)?(public/vendor/|package-lock\.json$|scripts/scan-private\.)'
}
fail=0

SECRETS='sk_live_[0-9A-Za-z]{10,}|rk_live_[0-9A-Za-z]{10,}|whsec_[0-9A-Za-z]{20,}|shippo_live_[0-9a-f]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[0-9A-Za-z]{30,}|AIza[0-9A-Za-z_-]{30,}|(database_id|account_id|zone_id)[[:space:]]*=[[:space:]]*"[0-9a-f]{8}-?[0-9a-f]{4}'
hits=$(files | xargs -0 grep -nIE "$SECRETS" 2>/dev/null)
if [ -n "$hits" ]; then echo "SECRETS FOUND — remove them and rotate the keys:"; printf '%s\n' "$hits" | cut -c1-160; fail=1; else echo "secrets: none found"; fi

WORDS=scripts/scan-private.words
if [ -f "$WORDS" ]; then
  pattern=$(grep -v -e '^#' -e '^[[:space:]]*$' "$WORDS" | paste -sd'|' -)
  if [ -n "$pattern" ]; then
    hits=$(files | xargs -0 grep -nIiE "$pattern" 2>/dev/null)
    n=$(printf '%s' "$hits" | grep -c . || true)
    if [ "$n" -gt 0 ]; then
      echo "business-specific strings: $n lines in $(printf '%s\n' "$hits" | cut -d: -f1 | sort -u | wc -l | tr -d ' ') files"
      printf '%s\n' "$hits" | cut -d: -f1 | sort | uniq -c | sort -rn | head -25
      [ "$STRICT" = 1 ] && fail=1
    else echo "business-specific strings: none found"; fi
  else
    echo "business-specific strings: not checked (scripts/scan-private.words has no patterns)"
  fi
else
  echo "business-specific strings: not checked (no scripts/scan-private.words on this machine)"
fi
exit $fail

#!/usr/bin/env bash
# Runs every test*.js file and fails if any of them exits non-zero OR logs
# an assertion that evaluated to false. The tests are plain node scripts
# that console.log("description:", boolean) rather than throw/assert, so a
# clean exit code alone does NOT mean everything passed — this script is
# the thing that actually turns a failed assertion into a failed build.
#
# Every test runs the same locally and in CI; nothing is skipped.

set -uo pipefail

fail=0
for f in test*.js; do
  out=$(node "$f" 2>&1)
  code=$?
  if [ $code -ne 0 ]; then
    echo "FAIL (exit $code): $f"
    echo "$out" | tail -30
    fail=1
    continue
  fi
  bad=$(echo "$out" | grep -E ': false$')
  if [ -n "$bad" ]; then
    echo "FAIL (assertion returned false): $f"
    echo "$bad"
    fail=1
    continue
  fi
  echo "PASS: $f"
done

exit $fail

#!/bin/sh
# Mim — run all test suites.
#
# Runs every headless test suite in the repo and prints one summary line
# per suite plus the grand total. Exits 0 only when every suite passes.
#
# Usage: ./run-tests.sh
set -u
cd "$(dirname "$0")"

total=0
rc=0

run() {
  name=$1
  file=$2
  if out=$(node "test/$file" 2>&1); then
    line=$(printf '%s\n' "$out" | grep -E 'passed' | tail -1)
    count=$(printf '%s\n' "$line" | grep -oE '[0-9]+' | head -1)
    total=$((total + count))
    printf 'PASS  %-18s %s\n' "$name" "$line"
  else
    rc=1
    printf 'FAIL  %-18s (last lines of its output below)\n' "$name"
    printf '%s\n' "$out" | tail -25
  fi
}

run 'core'              headless.js
run 'advanced'          advanced.js
run 'canvas-backend'    canvas-backend.js
run 'addons'            addons.js
run 'canvas-demo-smoke' canvas-demo-smoke.js

printf -- '----------------------------------------\n'
if [ "$rc" -eq 0 ]; then
  printf 'ALL SUITES PASSED (%s checks)\n' "$total"
else
  printf 'SOME SUITES FAILED\n'
fi
exit "$rc"

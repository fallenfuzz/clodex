#!/bin/sh
# test-digest.sh — run the Clodex test suite and write a ONE-LINE digest to
# STDERR, exiting with node's exit code. Built for the `run-tests` exec
# registry entry (replyStderr: true): the exec dispatcher returns only the
# LAST stderr line (200-char slice) on both the success and failure paths, so
# the whole digest lives on a single bounded line.
#   pass: "811/811 green"
#   fail: "798/811 green, 13 failing: name1; name2; …" (capped)
# Dependency-free: sh + awk only. The TAP reporter is forced so the summary
# grammar ("# pass N") doesn't shift with TTY detection across node versions.

cd "$(dirname "$0")/.." || exit 1

# Drain the exec payload (stdin) so the dispatcher's write can't EPIPE.
cat >/dev/null 2>/dev/null

out=$(node --test --test-reporter=tap 2>&1)
code=$?

pass=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="pass" {n=$3} END{print n+0}')
tests=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="tests" {n=$3} END{print n+0}')
fail=$(printf '%s\n' "$out" | awk '$1=="#" && $2=="fail" {n=$3} END{print n+0}')

if [ "$tests" -eq 0 ]; then
  # The runner never produced a summary — surface its last line, not silence.
  last=$(printf '%s\n' "$out" | awk 'NF{l=$0} END{print l}')
  printf '%.180s\n' "suite did not run: $last" 1>&2
  [ "$code" -eq 0 ] && exit 1
  exit "$code"
fi

if [ "$code" -eq 0 ] && [ "$fail" -eq 0 ]; then
  printf '%s/%s green\n' "$pass" "$tests" 1>&2
  exit 0
fi

# Failing test names ride the same line, ;-joined and capped. `not ok` lines
# appear at every nesting depth; parent wrappers of a failed subtest are noise
# but harmless — the cap keeps the reply bounded either way.
names=$(printf '%s\n' "$out" | awk 'sub(/^[ \t]*not ok [0-9]+ - /, "") {printf "%s%s", sep, $0; sep="; "}')
printf '%.180s\n' "$pass/$tests green, $fail failing: $names" 1>&2
[ "$code" -eq 0 ] && exit 1
exit "$code"

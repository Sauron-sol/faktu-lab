#!/usr/bin/env bash
# Exécute les 8 PoC et résume. Chaque PoC tourne sur une app fraîche (mock).
set -u
cd "$(dirname "$0")/.."

pass=0
fail=0
failed=()
for f in poc/poc-*.ts; do
  echo
  echo "════════════ $f ════════════"
  if node "$f"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed+=("$f")
  fi
done

echo
echo "════════════ RÉSUMÉ ════════════"
echo "PoC PASS: $pass / $((pass + fail))"
if [ "$fail" -gt 0 ]; then
  echo "PoC FAIL:"
  for f in "${failed[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "Tous les PoC reproduisent les vulnérabilités attendues."

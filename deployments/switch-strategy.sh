#!/usr/bin/env bash
# switch-strategy.sh  v1 | v2 | status
#
# The demo scripts (scripts/*.mjs) and the web app read ONE contract file: deployments/testnet.contract.json.
# This helper points that file at one of the two frozen Lotus deployments:
#
#   v1  testnet.contract.v1.json   lUSDC   on the PaltaLabs USDC DeFindex vault (idle on testnet, no yield)
#   v2  testnet.contract.v2.json   lUSDCb  on OUR DeFindex vault seeded into Blend (real interest)
#
# What it does (nothing else):
#   1. backs up the active testnet.contract.json  -> testnet.contract.backup-<utc>.tmp   (git-ignored by *.tmp)
#   2. copies the chosen frozen file over testnet.contract.json (atomic: cp to a temp name, then mv)
#   3. swaps the three S... keys the scripts read from testnet.secrets.json (admin, keeper, issuer),
#      because every deployment has its own admin / keeper / receipt issuer. It backs the secrets file up
#      first (testnet.secrets.backup-<utc>.secrets.json, git-ignored) and only touches those three keys;
#      maker / taker / peg_lp / rwa_issuer / blocked_taker are never modified.
#      The v2 keys live in testnet.strategies.secrets.json (.v2). The v1 keys are stashed there (.v1) the
#      first time you switch away from v1, so you can always come back.
#
# It does NOT touch testnet.classic.json (demo accounts, LBOND, offers). After switching, re-run the
# scripts that depend on the receipt (see deployments/README.md): the demo accounts need a trustline to the
# new receipt and their offers are denominated in the receipt of the deployment they were created on.
#
# Usage:   deployments/switch-strategy.sh status
#          deployments/switch-strategy.sh v2
#          deployments/switch-strategy.sh v1
#          deployments/switch-strategy.sh v2 --no-secrets      (swap the contract file only)
# LOTUS_DEPLOY_DIR=/some/dir deployments/switch-strategy.sh v2     (same override as scripts/lib/config.mjs)
#
# Needs: bash, jq.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${LOTUS_DEPLOY_DIR:-$HERE}"
ACTIVE="$DIR/testnet.contract.json"
V1="$DIR/testnet.contract.v1.json"
V2="$DIR/testnet.contract.v2.json"
SECRETS="$DIR/testnet.secrets.json"
STRAT_SECRETS="$DIR/testnet.strategies.secrets.json"
TS="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SWAP_SECRETS=1

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need jq

current_id() { [ -f "$ACTIVE" ] && jq -r '.lotus_vault_contract // empty' "$ACTIVE" || true; }
id_of() { jq -r '.lotus_vault_contract' "$1"; }

which_active() {
  local cur; cur="$(current_id)"
  if [ -z "$cur" ]; then echo "none"
  elif [ -f "$V1" ] && [ "$cur" = "$(id_of "$V1")" ]; then echo "v1"
  elif [ -f "$V2" ] && [ "$cur" = "$(id_of "$V2")" ]; then echo "v2"
  else echo "unknown ($cur)"; fi
}

status() {
  echo "deploy dir : $DIR"
  echo "active     : $(which_active)"
  for v in v1 v2; do
    f="$DIR/testnet.contract.$v.json"
    if [ -f "$f" ]; then
      printf '%-3s        : %s  receipt %s  vault %s\n' "$v" "$(id_of "$f")" "$(jq -r '.receipt.code' "$f")" "$(jq -r '.defindex_vault' "$f")"
    else
      echo "$v        : (missing $f)"
    fi
  done
}

atomic_write_json() { # atomic_write_json <dest> <json on stdin>
  local dest="$1" tmp
  tmp="$dest.$$.tmp"
  cat > "$tmp" && jq . "$tmp" >/dev/null && mv "$tmp" "$dest"
}

secret_of() { # secret_of <file> <jq path>
  [ -f "$1" ] && jq -r "$2 // empty" "$1" || true
}

swap_secrets() { # swap_secrets v1|v2
  local target="$1" cur
  [ -f "$SECRETS" ] || die "$SECRETS not found (the scripts keep admin/keeper/issuer keys there)"
  [ -f "$STRAT_SECRETS" ] || die "$STRAT_SECRETS not found (holds the v2 keys under .v2)"

  # stash the keys that are active now under .v1 the first time we leave v1 (never overwrite an existing stash)
  if [ -z "$(secret_of "$STRAT_SECRETS" '.v1.keeper')" ]; then
    cur_keeper="$(secret_of "$SECRETS" '.keeper')"
    if [ -n "$cur_keeper" ] && [ "$cur_keeper" != "$(secret_of "$STRAT_SECRETS" '.v2.keeper')" ]; then
      jq --slurpfile s "$SECRETS" '.v1 = ($s[0] | {admin, keeper, issuer})' "$STRAT_SECRETS" | atomic_write_json "$STRAT_SECRETS"
      echo "stashed the current v1 admin/keeper/issuer keys in $(basename "$STRAT_SECRETS") (.v1)"
    fi
  fi

  local src
  src="$(jq -c ".${target} | {admin, keeper, issuer}" "$STRAT_SECRETS")"
  if [ "$src" = "null" ] || [ "$(jq -r '.keeper // empty' <<<"$src")" = "" ]; then
    die "no .${target} admin/keeper/issuer keys in $(basename "$STRAT_SECRETS"); cannot swap secrets"
  fi
  cp -p "$SECRETS" "$DIR/testnet.secrets.backup-$TS.secrets.json"
  jq --argjson k "$src" '. + $k' "$SECRETS" | atomic_write_json "$SECRETS"
  chmod 600 "$SECRETS" || true
  echo "secrets: admin/keeper/issuer in $(basename "$SECRETS") now belong to $target (backup: testnet.secrets.backup-$TS.secrets.json)"
}

switch_to() {
  local target="$1" src
  case "$target" in v1) src="$V1" ;; v2) src="$V2" ;; *) die "usage: $0 v1|v2|status" ;; esac
  [ -f "$src" ] || die "$src not found"
  jq -e '.lotus_vault_contract and .receipt.code and .receipt.issuer' "$src" >/dev/null || die "$src looks incomplete"
  if [ "$(which_active)" = "$target" ]; then
    echo "testnet.contract.json already points at $target ($(id_of "$src")); re-applying the secrets and nothing else"
  elif [ -f "$ACTIVE" ]; then
    cp -p "$ACTIVE" "$DIR/testnet.contract.backup-$TS.tmp"
    echo "backup: testnet.contract.backup-$TS.tmp"
  fi
  if [ "$SWAP_SECRETS" = 1 ]; then swap_secrets "$target"; else echo "secrets: left untouched (--no-secrets)"; fi
  local tmp; tmp="$ACTIVE.$$.tmp"
  cp "$src" "$tmp" && mv "$tmp" "$ACTIVE"
  echo "testnet.contract.json -> $target  ($(id_of "$ACTIVE"), receipt $(jq -r '.receipt.code' "$ACTIVE"))"
  echo
  status
}

cmd="${1:-status}"
shift || true
for a in "$@"; do
  case "$a" in
    --no-secrets) SWAP_SECRETS=0 ;;
    *) die "unknown option $a (usage: $0 v1|v2|status [--no-secrets])" ;;
  esac
done
case "$cmd" in
  status) status ;;
  v1|v2) switch_to "$cmd" ;;
  *) die "usage: $0 v1|v2|status" ;;
esac

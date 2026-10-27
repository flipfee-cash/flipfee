#!/usr/bin/env bash
# flipfee release (DESIGN.md §4): build the client, keeper and app, upload to the box, restart, health check.
# Run it on your Mac from any folder:
#
#   bash flipfee/release.sh              build, check the copy, upload the site and the server, restart
#   bash flipfee/release.sh --app-only   the site only (the server keeps running)
#   bash flipfee/release.sh --dry-run    build and check; the box stays as it is
#
# The box: the site in /srv/ft1/flipfee (Caddy: flipfee.cash, /api/* → 127.0.0.1:5295), the server in
# /opt/flipfee-server (unit flipfee-server, settings /etc/flipfee/server.env, data /var/lib/flipfee).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

HOST="${FLIPFEE_HOST:-root@5.75.168.69}"
KEY="${FLIPFEE_SSH_KEY:-$HOME/.ssh/kiln_deploy}"
SITE="https://flipfee.cash"

APP_ONLY=0
DRY=0
for a in "$@"; do
  case "$a" in
    --app-only) APP_ONLY=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown flag: $a (see --help)" ;;
  esac
done
[ -f "$KEY" ] || die "no SSH key at $KEY (set FLIPFEE_SSH_KEY)"

say "program client and keeper"
(cd program && npm run --silent build:client && npm run --silent build:keeper)
if [ "$APP_ONLY" = 0 ]; then
  say "server: tests, vendor copies"
  (cd server && npm test --silent >/dev/null && npm run --silent vendor)
fi
say "app: copy check, build"
(cd app && npm run --silent copy && npm run --silent build)
if grep -lE '\b(demo|testnet|fixture)\b' app/dist/index.html app/dist/assets/*.js >/dev/null; then die "app/dist mentions demo/testnet/fixture"; fi

if [ "$DRY" = 1 ]; then
  say "dry run: nothing uploaded"
  exit 0
fi

SOCK="$(mktemp -u /tmp/flipfee-ssh.XXXXXX)"
for i in 1 2 3 4 5; do
  ssh -i "$KEY" -o ConnectTimeout=20 -o ControlMaster=yes -o ControlPersist=10m -S "$SOCK" -fN "$HOST" 2>/dev/null && break
  [ "$i" = 5 ] && die "the box does not answer over SSH"
  sleep $((i * 3))
done
trap 'ssh -S "$SOCK" -O exit "$HOST" 2>/dev/null || true' EXIT
RSH="ssh -S $SOCK"

say "site → /srv/ft1/flipfee"
rsync -az --delete -e "$RSH" app/dist/ "$HOST:/srv/ft1/flipfee/"

if [ "$APP_ONLY" = 0 ]; then
  say "server → /opt/flipfee-server, restart"
  rsync -az --delete -e "$RSH" --exclude node_modules --exclude data --exclude .env --exclude test server/ "$HOST:/opt/flipfee-server/"
  $RSH "$HOST" 'set -e
    cd /opt/flipfee-server && npm ci --omit=dev --no-audit --no-fund --silent && chown -R root:root /opt/flipfee-server
    cmp -s deploy/flipfee-server.service /etc/systemd/system/flipfee-server.service || { cp deploy/flipfee-server.service /etc/systemd/system/; systemctl daemon-reload; }
    systemctl restart flipfee-server'
  sleep 5
fi

say "health"
curl -fsS -m 20 "$SITE/api/health" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const h=JSON.parse(s);console.log(`ok=${h.ok} cluster=${h.cluster} program=${h.programId} keeper=${h.keeper?.on} tracked=${h.tracking?.tracked}`);if(!h.ok)process.exit(1)})'
curl -fsS -m 20 -o /dev/null -w "site %{http_code}\n" "$SITE/"
say "done: $SITE"

#!/bin/sh
# Installs a Lightkeeper package the server has downloaded and checked against the
# release's manifest, then starts the start-up hook and the server again.
# Run by the server, detached and from a copy outside the app: installing replaces
# the app, and the hook it starts stops the old server.
#
#   update.sh <ipk> <version>
#
# Writes what happened to $LIGHTKEEPER_STATUS for the settings page, and to the log.
IPK=$1
V=$2
ID=io.github.chiotas.lightkeeper
APPDIR=${LIGHTKEEPER_APPDIR:-/media/developer/apps/usr/palm/applications/$ID}
LS=${LIGHTKEEPER_LUNA_SEND:-/usr/bin/luna-send}
STATUS=${LIGHTKEEPER_STATUS:-/var/lib/lightkeeper/update.json}
LOG=${LIGHTKEEPER_LOG:-/tmp/lightkeeper.log}

state() {
  printf '{"state":"%s","version":"%s","error":"%s","at":%s000}\n' "$1" "$V" "$2" "$(date +%s)" > "$STATUS"
  echo "$(date '+%F %T') update to $V: $1 $2" >> "$LOG"
}

# As lightkeeper.sh install does over SSH; luna-send without a terminal needs stdin closed.
T=
command -v timeout >/dev/null 2>&1 && T=$(timeout -t 1 true 2>/dev/null && echo 'timeout -t 180' || echo 'timeout 180')
r=$($T "$LS" -i luna://com.webos.appInstallService/dev/install "{\"id\":\"$ID\",\"ipkUrl\":\"$IPK\",\"subscribe\":true}" </dev/null 2>&1 |
  grep -m1 -oE '"state": *"installed"|"state": *"[^"]*fail[^"]*"|"errorText": *"[^"]*"|"returnValue": *false' | tr -d '"\\' | tr '\n' ' ')
rm -f "$IPK"
case "$r" in
  *installed*) ;;
  *) state failed "the TV did not install it: ${r:-no answer}"; exit 0 ;;
esac
state installed ""
sh "$APPDIR/service/setup.sh" >/dev/null 2>&1 || echo "$(date '+%F %T') update to $V: setup.sh did not run" >> "$LOG"
exit 0

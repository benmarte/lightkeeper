#!/bin/sh
# Puts Lightkeeper's boot hook in place and starts it, or starts it again after
# an update. Run as root: by the app itself through the Homebrew Channel's exec
# service when its server does not answer with the app's version, or by
# lightkeeper.sh over SSH. Safe to run any number of times. Prints one JSON line.
HERE=$(cd "$(dirname "$0")" && pwd)
HOOKDIR=/var/lib/webosbrew/init.d
fail() { printf '{"ok":false,"error":"%s"}\n' "$1"; exit 0; }

[ -d "$HOOKDIR" ] || fail "the Homebrew Channel is not installed"
[ -x /usr/bin/node ] || fail "this TV has no node"
[ -f "$HERE/server.js" ] || fail "the app has no server in it"

# A package may store files writable by all: the hook and server run as root.
chmod -R go-w "$(dirname "$HERE")" 2>/dev/null
chmod 755 "$HERE/lightkeeper-init" "$HERE/setup.sh"
mkdir -p /var/lib/lightkeeper && chmod 700 /var/lib/lightkeeper
# A link into the app rather than a copy: once the app is gone, nothing runs at boot.
ln -sf "$HERE/lightkeeper-init" "$HOOKDIR/60-lightkeeper"
cd /
# Detached, with nothing left on the exec service's output, which waits for it to close.
setsid "$HOOKDIR/60-lightkeeper" </dev/null >/dev/null 2>&1 &
printf '{"ok":true}\n'

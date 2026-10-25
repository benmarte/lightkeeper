#!/bin/sh
# The settings server against this stand-in TV, for previews on a computer:
# settings on http://127.0.0.1:8090/, the Home at http://127.0.0.1:8091/.
F=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$F/data" "$F/tvweb"
: > "$F/hook"
export LIGHTKEEPER_DATA="$F/data" LIGHTKEEPER_TVWEB="$F/tvweb" LIGHTKEEPER_HOOK="$F/hook" \
  LIGHTKEEPER_LUNA_SEND="$F/luna-send" LIGHTKEEPER_KEY_FILTERS="$F/KeyFilters" LIGHTKEEPER_PORT_FILE="$F/port" \
  LIGHTKEEPER_SESSION="$F/session"
python3 -m http.server 8091 --bind 127.0.0.1 --directory "$F/../../app" >/dev/null 2>&1 &
trap 'kill $!' EXIT INT TERM
node "$F/../../app/service/server.js"

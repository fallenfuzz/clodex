#!/usr/bin/env bash
# Install a mounted SSH pubkey into clodex's authorized_keys (boot oneshot).
set -eu
KEY=/authorized_keys
DEST=/home/clodex/.ssh/authorized_keys
[ -f "$KEY" ] || { echo "authorize-key: no $KEY mounted — password auth only"; exit 0; }
install -d -m 700 -o clodex -g clodex /home/clodex/.ssh
install -m 600 -o clodex -g clodex "$KEY" "$DEST"
echo "authorize-key: installed $(wc -l < "$DEST") key(s) for clodex"

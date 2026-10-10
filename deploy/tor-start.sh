#!/bin/sh
# Starts Tor, then shares the onion hostname with the app so its
# dashboard can fill it in. The private key never leaves this container.
set -eu
tor -f /etc/tor/torrc &
tor_pid=$!
hostname=/var/lib/tor/nymdispenser/hostname
while [ ! -s "$hostname" ]; do
  kill -0 "$tor_pid" 2>/dev/null || exit 1
  sleep 1
done
cp "$hostname" /run/onion/hostname.tmp
chmod 644 /run/onion/hostname.tmp
mv /run/onion/hostname.tmp /run/onion/hostname
wait "$tor_pid"

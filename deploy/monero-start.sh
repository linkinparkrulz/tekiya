#!/bin/sh
# Starts the view-only wallet RPC. A random login is created once and shared
# with the app through the monero-secret volume. The node is set later by
# Tekiya (dashboard), together with its wallet file.
set -eu
login=/monero-secret/rpc-login
if [ ! -s "$login" ]; then
  umask 027
  secret="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'tekiya:%s\n' "$secret" > "$login.tmp"
  mv "$login.tmp" "$login"
fi
network=""
[ "${NYM_NETWORK:-testnet4}" = "mainnet" ] || network="--stagenet"
exec monero-wallet-rpc $network \
  --wallet-dir /wallet \
  --rpc-bind-ip 0.0.0.0 --rpc-bind-port 18083 --confirm-external-bind \
  --rpc-login "$(cat "$login")" \
  --untrusted-daemon --non-interactive \
  --log-file /wallet/monero-wallet-rpc.log --max-log-files 2

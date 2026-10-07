#!/usr/bin/env bash
# A throwaway CA and broker certificate for tests and development (TASK-906). Never use
# these in production: use your organization's CA. Writes ca.crt, server.crt, server.key
# (and the CA key, kept only to sign) into the given directory.
#
#   broker/dev-ca.sh <dir> [hostname...]     # default hostnames: localhost 127.0.0.1
set -euo pipefail
dir="${1:?usage: dev-ca.sh <dir> [hostname...]}"; shift || true
names=("${@:-localhost}")
[ $# -gt 0 ] || names=(localhost 127.0.0.1)
mkdir -p "$dir"
san=""
for name in "${names[@]}"; do
  if [[ "$name" =~ ^[0-9.]+$ ]]; then san+="IP:$name,"; else san+="DNS:$name,"; fi
done
san="${san%,}"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj "/CN=Z-Factory development CA" -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -subj "/CN=${names[0]}" -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
  -days 30 -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san") \
  -out "$dir/server.crt" 2>/dev/null
rm -f "$dir/server.csr" "$dir/ca.srl"
# The broker runs as uid 1883 in eclipse-mosquitto:2; it must read its key.
chmod 0644 "$dir/server.crt" "$dir/ca.crt"
chmod 0644 "$dir/server.key"
echo "$dir: ca.crt server.crt server.key (SAN $san)" >&2

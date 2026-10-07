#!/usr/bin/env bash
# Installs, upgrades or removes the Thin Client Agent as a systemd service on an edge host
# (TASK-906, docs/edge-deployment.md). Run as root on the target.
#
#   install.sh install  --binary zfactory-agent-<v>-linux-<arch> --sums SHA256SUMS-<v>
#   install.sh upgrade  --binary ... --sums ...      # keeps settings, state and spool
#   install.sh uninstall [--purge]                   # --purge also deletes state and settings
#
# The binary must match its line in the SHA256SUMS file. Settings go to
# /etc/zfactory-agent/agent.env (created from agent.env.example once, never overwritten);
# state (staging/, active/, rejected/, spool/) lives in /var/lib/zfactory-agent.
# --root DIR installs under DIR without touching systemd or users (for packaging tests).
set -euo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

action="${1:-}"; [ -n "$action" ] || usage; shift
binary="" sums="" root="" purge=0
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) binary="$2"; shift 2 ;;
    --sums) sums="$2"; shift 2 ;;
    --root) root="${2%/}"; shift 2 ;;
    --purge) purge=1; shift ;;
    *) usage ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
bin="$root/usr/local/bin/zfactory-agent"
unit="$root/etc/systemd/system/zfactory-agent.service"
etc="$root/etc/zfactory-agent"
state="$root/var/lib/zfactory-agent"
user=zfactory-agent

say() { echo "zfactory-agent: $*" >&2; }
system() { if [ -z "$root" ]; then "$@"; else say "(staging) would run: $*"; fi; }

verify() {
  [ -f "$binary" ] || { say "no binary at $binary"; exit 1; }
  [ -f "$sums" ] || { say "no checksum file at $sums"; exit 1; }
  local name expected actual
  name="$(basename "$binary")"
  expected="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$sums")"
  [ -n "$expected" ] || { say "$name is not listed in $sums"; exit 1; }
  actual="$(sha256sum "$binary" | cut -d' ' -f1)"
  [ "$expected" = "$actual" ] || { say "checksum mismatch for $name: refusing to install"; exit 1; }
}

place_binary() {
  install -d -m 0755 "$(dirname "$bin")"
  # Atomic: a running agent keeps its old file until it restarts.
  install -m 0755 "$binary" "$bin.new"
  mv -f "$bin.new" "$bin"
}

case "$action" in
  install)
    verify
    if [ -z "$root" ] && ! id -u "$user" >/dev/null 2>&1; then
      useradd --system --no-create-home --home-dir /var/lib/zfactory-agent --shell /usr/sbin/nologin "$user"
    fi
    place_binary
    install -d -m 0755 "$(dirname "$unit")"
    install -m 0644 "$here/zfactory-agent.service" "$unit"
    install -d -m 0750 "$etc"
    if [ ! -f "$etc/agent.env" ]; then
      install -m 0640 "$here/agent.env.example" "$etc/agent.env"
      say "edit $etc/agent.env, put the MQTT password alone in $etc/mqtt-password (mode 0640) and the broker CA in $etc/broker-ca.crt"
    fi
    install -d -m 0750 "$state"
    if [ -z "$root" ]; then chown -R root:"$user" "$etc"; chmod 0640 "$etc"/agent.env; fi
    system systemctl daemon-reload
    system systemctl enable zfactory-agent.service
    say "installed $("$bin" -version). Start it with: systemctl start zfactory-agent"
    ;;
  upgrade)
    verify
    [ -f "$bin" ] || { say "not installed; use install"; exit 1; }
    previous="$("$bin" -version 2>/dev/null || echo unknown)"
    cp -p "$bin" "$bin.previous"
    place_binary
    install -m 0644 "$here/zfactory-agent.service" "$unit"
    system systemctl daemon-reload
    system systemctl restart zfactory-agent.service
    say "upgraded $previous -> $("$bin" -version); the previous binary is $bin.previous"
    ;;
  uninstall)
    system systemctl disable --now zfactory-agent.service
    rm -f "$bin" "$bin.previous" "$unit"
    system systemctl daemon-reload
    if [ "$purge" = 1 ]; then
      rm -rf "$state" "$etc"
      if [ -z "$root" ] && id -u "$user" >/dev/null 2>&1; then userdel "$user"; fi
      say "removed with its state and settings"
    else
      say "removed; settings in $etc and state (incl. any unsent spool) in $state are kept"
    fi
    ;;
  *) usage ;;
esac

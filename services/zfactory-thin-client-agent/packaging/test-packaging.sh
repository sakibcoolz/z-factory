#!/usr/bin/env bash
# Tests the deployment kit without root (TASK-906): builds the binaries, then runs
# install.sh into a staging root and checks every path: checksum refusal, install layout
# and modes, upgrade keeping settings and state, uninstall keeping state, purge; and lets
# systemd check the unit. Needs Go and, for the unit check, systemd-analyze.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

"$here/packaging/build.sh" 1.0.0-kit "$work/dist" 2>/dev/null
"$here/packaging/build.sh" 1.0.1-kit "$work/dist" 2>/dev/null
v1="$work/dist/zfactory-agent-1.0.0-kit-linux-amd64"
v2="$work/dist/zfactory-agent-1.0.1-kit-linux-amd64"
s1="$work/dist/SHA256SUMS-1.0.0-kit"
s2="$work/dist/SHA256SUMS-1.0.1-kit"
root="$work/root"
install_sh="$here/packaging/install.sh"
mode() { stat -c %a "$root$1"; }

# A binary that does not match its checksum is refused.
cp "$v1" "$work/zfactory-agent-1.0.0-kit-linux-amd64"
printf 'x' >> "$work/zfactory-agent-1.0.0-kit-linux-amd64"
if "$install_sh" install --binary "$work/zfactory-agent-1.0.0-kit-linux-amd64" --sums "$s1" --root "$root" 2>/dev/null; then
  fail "a tampered binary was installed"
fi
[ ! -e "$root/usr/local/bin/zfactory-agent" ] || fail "something was installed from a tampered binary"
ok "tampered binary refused"

"$install_sh" install --binary "$v1" --sums "$s1" --root "$root" 2>/dev/null
[ "$("$root/usr/local/bin/zfactory-agent" -version)" = 1.0.0-kit ] || fail "installed version"
[ "$(mode /etc/zfactory-agent)" = 750 ] || fail "settings directory mode $(mode /etc/zfactory-agent)"
[ "$(mode /etc/zfactory-agent/agent.env)" = 640 ] || fail "agent.env mode"
[ "$(mode /var/lib/zfactory-agent)" = 750 ] || fail "state directory mode"
[ "$(mode /usr/local/bin/zfactory-agent)" = 755 ] || fail "binary mode"
ok "installed with the expected layout and modes"

# Settings and state survive an upgrade; the previous binary is kept.
echo "ZFACTORY_AGENT_ID=edited" >> "$root/etc/zfactory-agent/agent.env"
mkdir -p "$root/var/lib/zfactory-agent/spool" && echo spooled > "$root/var/lib/zfactory-agent/spool/telemetry.db"
"$install_sh" upgrade --binary "$v2" --sums "$s2" --root "$root" 2>/dev/null
[ "$("$root/usr/local/bin/zfactory-agent" -version)" = 1.0.1-kit ] || fail "upgraded version"
[ "$("$root/usr/local/bin/zfactory-agent.previous" -version)" = 1.0.0-kit ] || fail "previous binary kept"
grep -q "ZFACTORY_AGENT_ID=edited" "$root/etc/zfactory-agent/agent.env" || fail "settings overwritten by the upgrade"
[ -f "$root/var/lib/zfactory-agent/spool/telemetry.db" ] || fail "spool lost in the upgrade"
# Installing again never overwrites settings either.
"$install_sh" install --binary "$v2" --sums "$s2" --root "$root" 2>/dev/null
grep -q "ZFACTORY_AGENT_ID=edited" "$root/etc/zfactory-agent/agent.env" || fail "settings overwritten by install"
ok "upgrade keeps settings, state and spool, and the previous binary"

"$install_sh" uninstall --root "$root" 2>/dev/null
[ ! -e "$root/usr/local/bin/zfactory-agent" ] || fail "binary left after uninstall"
[ -f "$root/var/lib/zfactory-agent/spool/telemetry.db" ] || fail "uninstall removed unsent telemetry"
"$install_sh" uninstall --purge --root "$root" 2>/dev/null
[ ! -e "$root/var/lib/zfactory-agent" ] && [ ! -e "$root/etc/zfactory-agent" ] || fail "purge left state"
ok "uninstall keeps state; purge removes it"

if command -v systemd-analyze >/dev/null; then
  unit="$work/zfactory-agent.service"
  sed "s|^ExecStart=.*|ExecStart=$v1|; s|^EnvironmentFile=.*|EnvironmentFile=-$work/agent.env|" \
    "$here/packaging/zfactory-agent.service" > "$unit"
  if output="$(systemd-analyze verify "$unit" 2>&1)" && [ -z "$output" ]; then
    ok "systemd accepts the unit"
  else
    fail "systemd-analyze: $output"
  fi
fi

# The container image definition names the same binaries.
grep -q 'dist/zfactory-agent-${VERSION}-linux-${TARGETARCH}${TARGETVARIANT}' "$here/packaging/Dockerfile" || fail "Dockerfile binary path"
grep -q '^USER 65532:65532' "$here/packaging/Dockerfile" || fail "the image must not run as root"
ok "container image runs the checksummed binary as non-root"
echo "packaging: all checks passed"

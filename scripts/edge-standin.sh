#!/usr/bin/env bash
# The production-like edge run (TASK-906, docs/edge-deployment.md → Stand-in run): builds
# the agent and its container image, starts real OpenPLC runtimes with the PLC lab, runs
# the Web Factory stand-in test against them and N simulated PLCs, writes the measured
# report, and removes everything it started.
#
#   scripts/edge-standin.sh [report.json] [N simulated PLCs, at least 10] [OpenPLC runtimes]
#   defaults: ./edge-standin-report.json 200 2
#
# Needs Docker, Go, the root .env (TEST_DATABASE_URL) and apps/web-factory/.env
# (WEB_FACTORY_TEST_DATABASE_URL). Uses test databases only.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
report="$(realpath -m "${1:-./edge-standin-report.json}")"
n="${2:-200}"
openplc="${3:-2}"
version="standin-$(git -C "$repo" rev-parse --short HEAD)"
lab="$(mktemp -d)"
lab_pid=""

tsx="$repo/node_modules/.bin/tsx"
lab_tool() { (cd "$repo" && set -a && . ./.env && set +a && exec "$tsx" --conditions=react-server test/edge-standin/plc-lab.ts "$@"); }

cleanup() {
  if [ -n "$lab_pid" ] && kill -0 "$lab_pid" 2>/dev/null; then
    echo "stopping the PLC lab" >&2
    kill -TERM "$lab_pid"
    # The lab removes its runtimes and factory on SIGTERM; give it the time to.
    for _ in $(seq 1 30); do kill -0 "$lab_pid" 2>/dev/null || break; sleep 1; done
  elif [ -n "$lab_pid" ]; then
    echo "the PLC lab had already ended" >&2
  fi
  # Whatever is left, from this run or an interrupted one.
  lab_tool --cleanup >&2 || true
  rm -rf "$lab"
}
trap cleanup EXIT

echo "building the agent $version and its image" >&2
(cd "$repo/services/zfactory-thin-client-agent" && packaging/build.sh "$version" >/dev/null 2>&1 \
  && docker build -q -f packaging/Dockerfile --build-arg VERSION="$version" -t "zfactory-agent:$version" . >/dev/null)

if [ "$openplc" -gt 0 ]; then
  echo "starting $openplc OpenPLC runtime(s)" >&2
  # One subshell that becomes tsx: $! is the lab itself, so SIGTERM reaches it.
  (cd "$repo" && set -a && . ./.env && set +a && exec "$tsx" --conditions=react-server test/edge-standin/plc-lab.ts "$lab" "$openplc") &
  lab_pid=$!
  for _ in $(seq 1 90); do
    [ -f "$lab/manifest.json" ] && break
    kill -0 "$lab_pid" 2>/dev/null || { echo "the PLC lab failed" >&2; exit 1; }
    sleep 2
  done
  [ -f "$lab/manifest.json" ] || { echo "the PLC lab did not get ready" >&2; exit 1; }
fi

echo "running the stand-in with $n simulated PLCs" >&2
cd "$repo/apps/web-factory"
WEB_FACTORY_TEST_DOCKER=1 AGENT_IMAGE="zfactory-agent:$version" EDGE_STANDIN_N="$n" \
  EDGE_STANDIN_OPENPLC="$([ "$openplc" -gt 0 ] && echo "$lab" || true)" EDGE_STANDIN_REPORT="$report" \
  npx vitest run test/edge-standin.test.ts
echo "report: $report" >&2

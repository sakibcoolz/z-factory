#!/usr/bin/env bash
# Builds the Thin Client Agent for edge hosts (TASK-906, docs/edge-deployment.md):
# static Linux binaries for amd64 (PCs, gateways), arm64 (Raspberry Pi 4/5 on a 64-bit OS)
# and armv7 (32-bit Raspberry Pi OS), with SHA256SUMS. Reproducible: no cgo, no build
# paths, no build id. Needs Go 1.26.
#
#   packaging/build.sh [version] [out-dir]      # defaults: git describe, ./dist
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:-$(git -C "$here" describe --tags --always --dirty 2>/dev/null || echo dev)}"
out="${2:-$here/dist}"
mkdir -p "$out"

build() {
  local goos=$1 goarch=$2 goarm=${3:-} name
  name="zfactory-agent-${version}-${goos}-${goarch}${goarm:+v$goarm}"
  echo "building $name" >&2
  (
    cd "$here"
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch GOARM=$goarm \
      go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=$version" \
      -o "$out/$name" ./cmd/zfactory-agent
  )
}

build linux amd64
build linux arm64
build linux arm 7

(cd "$out" && sha256sum zfactory-agent-"$version"-* > "SHA256SUMS-$version")
echo "$out/SHA256SUMS-$version" >&2

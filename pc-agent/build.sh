#!/usr/bin/env bash
# Builds harness-pilot PC for every download target of the server (pcbridge.TARGETS) into dist/ (gitignored):
#   HarnessPC-windows-{amd64,arm64}.exe, harness-pc-{darwin,linux}-{amd64,arm64}
#   SHA256SUMS     sha256sum format, for the release page
#   files.json     name, target, os, arch, size and sha256 of each file, + the version, tag and Go toolchain
#   pc_agent.json  the server manifest for this version: it replaces server/maxxing/pc_agent.json once a release
#                  with these exact files is published (docs/dev/INSTALLER.md, "Releasing the computer agent")
# Reproducible: the Go toolchain pinned in go.mod, CGO off, -trimpath, no VCS stamp, empty build id - the same
# commit built with the same VERSION gives the same SHA-256 on any machine.
#   VERSION=0.1.0 ./build.sh        SKIP_CHECKS=1 skips go vet (3 systems) and go test, run first otherwise
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-0.1.0}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "VERSION must look like 1.2.3 or 1.2.3-rc.1 (got '$VERSION')" >&2
  exit 1
fi
GO="${GO:-go}"
TOOLCHAIN="$(awk '$1 == "toolchain" {print $2}' go.mod)"
[ -n "$TOOLCHAIN" ] || { echo "go.mod has no toolchain line" >&2; exit 1; }
export GOTOOLCHAIN="$TOOLCHAIN"              # exactly this Go (downloaded and checksum-verified by go if missing)
export CGO_ENABLED=0 GOFLAGS="-trimpath -buildvcs=false"
LDFLAGS="-s -w -buildid= -X main.version=${VERSION}"
MANIFEST=../server/maxxing/pc_agent.json     # its download URL template goes into dist/pc_agent.json
URL="$(sed -n 's/^ *"url": *"\([^"]*\)".*/\1/p' "$MANIFEST")"
case "$URL" in *"{version}"*"{name}"*) ;; *) echo "$MANIFEST: url needs {version} and {name}" >&2; exit 1 ;; esac
if command -v sha256sum >/dev/null; then sha() { sha256sum "$@"; }; else sha() { shasum -a 256 "$@"; }; fi
# target, file name (pcbridge.TARGETS), extra linker flags
TARGETS=(
  "windows-amd64 HarnessPC-windows-amd64.exe -H windowsgui"
  "windows-arm64 HarnessPC-windows-arm64.exe -H windowsgui"
  "darwin-arm64 harness-pc-darwin-arm64"
  "darwin-amd64 harness-pc-darwin-amd64"
  "linux-amd64 harness-pc-linux-amd64"
  "linux-arm64 harness-pc-linux-arm64"
)

if [ "${SKIP_CHECKS:-}" != 1 ]; then
  for os in darwin linux windows; do GOOS=$os "$GO" vet ./...; done
  "$GO" test -count=1 ./...
fi

rm -rf dist && mkdir -p dist
# Windows: icon + version info (the product logo web/public/icons/icon-512.png, resized by go-winres) as rsrc_windows_*.syso, linked by go build
"$GO" run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64,arm64 --manifest gui --icon ../web/public/icons/icon-512.png \
  --product-name "harness-pilot PC" --file-description "harness-pilot PC - browser of my PC for harness-pilot" \
  --product-version "${VERSION%%-*}" --file-version "${VERSION%%-*}" --original-filename HarnessPC.exe
for t in "${TARGETS[@]}"; do
  read -r target name extra <<<"$t"
  GOOS="${target%-*}" GOARCH="${target#*-}" "$GO" build -ldflags "$LDFLAGS ${extra:-}" -o "dist/$name" .
done

cd dist
sha HarnessPC-* harness-pc-* > SHA256SUMS
sum_of() { awk -v n="$1" '$2 == n {print $1}' SHA256SUMS; }
{
  printf '{\n  "version": "%s",\n  "tag": "pc-agent-v%s",\n  "go": "%s",\n  "files": [\n' "$VERSION" "$VERSION" "$TOOLCHAIN"
  sep=""
  for t in "${TARGETS[@]}"; do
    read -r target name _ <<<"$t"
    printf '%s    {"name": "%s", "target": "%s", "os": "%s", "arch": "%s", "size": %s, "sha256": "%s"}' "$sep" \
      "$name" "$target" "${target%-*}" "${target#*-}" "$(wc -c <"$name" | tr -d ' ')" "$(sum_of "$name")"
    sep=$',\n'
  done
  printf '\n  ]\n}\n'
} >files.json
{
  printf '{\n  "version": "%s",\n  "url": "%s",\n  "files": {\n' "$VERSION" "$URL"
  sep=""
  for t in "${TARGETS[@]}"; do
    read -r _ name _ <<<"$t"
    printf '%s    "%s": "%s"' "$sep" "$name" "$(sum_of "$name")"
    sep=$',\n'
  done
  printf '\n  }\n}\n'
} >pc_agent.json
host="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
if [ -x "harness-pc-$host" ]; then "./harness-pc-$host" --version; fi
ls -l

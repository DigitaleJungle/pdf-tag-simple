#!/usr/bin/env bash
# Builds the Windows installers locally and publishes a GitHub release for the
# current version: .msi + .exe as assets, notes = .msi download link + the
# CHANGELOG.md sections since the last published release. The vX.Y.Z tag must already be pushed.
# Usage: bash scripts/publish-release.sh        (needs gh, logged in)
set -euo pipefail
cd "$(dirname "$0")/.."

gh=${GH:-gh}
command -v "$gh" >/dev/null || gh="/c/Program Files/GitHub CLI/gh.exe"
repo=DigitaleJungle/pdf-tag-simple

v=$(node -p "require('./src-tauri/tauri.conf.json').version")
tag="v$v"

# Notes cover this version plus every earlier one that never got a GitHub release
# (tagged without publishing): all CHANGELOG sections newer than the latest release.
prev=$("$gh" release list --repo "$repo" --limit 20 --json tagName -q '.[].tagName' | grep -vx "$tag" | head -1 || true)
changes=$(awk -v v="$v" -v p="${prev#v}" '
  index($0, "## [" v "]") == 1 {f=1; next}
  f && /^## \[/ && (p == "" || index($0, "## [" p "]") == 1) {exit}
  f' CHANGELOG.md)
[ -n "$changes" ] || { echo "No CHANGELOG.md section for $v"; exit 1; }

npm run tauri build

# Copy to names without spaces, so the download link in the notes is predictable.
out=src-tauri/target/release/publish
rm -rf "$out" && mkdir -p "$out"
msi="PDF-Tag-Simple_${v}_x64.msi"
exe="PDF-Tag-Simple_${v}_x64-setup.exe"
cp src-tauri/target/release/bundle/msi/*_"${v}"_x64_en-US.msi "$out/$msi"
cp src-tauri/target/release/bundle/nsis/*_"${v}"_x64-setup.exe "$out/$exe"

{
  echo "## Download"
  echo
  echo "Download **[$msi](https://github.com/$repo/releases/download/$tag/$msi)** and run it."
  echo "The installer isn't code-signed: if Windows SmartScreen warns you, click **More info → Run anyway**."
  echo
  echo "## What's in this release"
  echo "$changes"
} > "$out/notes.md"

"$gh" release create "$tag" "$out/$msi" "$out/$exe" \
  --repo "$repo" --verify-tag --title "PDF Tag Simple $tag" --notes-file "$out/notes.md"

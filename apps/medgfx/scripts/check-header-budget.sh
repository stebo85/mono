#!/usr/bin/env bash
# Header-first budget: 4D over the cap is accepted, 3D over the cap is refused.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)/check
trap 'rm -rf "$(dirname "$out")"' EXIT
swiftc -o "$out" QuickLookPreview/GzipPeek.swift QuickLookPreview/VolumeHeader.swift \
  scripts/check-header-budget.swift
"$out"

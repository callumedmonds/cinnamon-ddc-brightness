#!/usr/bin/env bash
# Runs the parser tests against captured real ddcutil output.
# Needs gjs — the same JS engine Cinnamon runs the applet on.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v gjs >/dev/null || { echo "gjs not installed (Debian: sudo apt install gjs)" >&2; exit 1; }

SRC=../files/ddc-brightness@callum/applet.js
# The parsers are pure top-level functions, so they can be lifted out and
# exercised without any of Cinnamon's imports.
extract() { awk "/^function $1\(/,/^}\$/" "$SRC"; }
{ echo 'const VCP_COLOR_PRESET = "14";'
  extract parseVcpLine; extract parseDetect; extract parseColorPresets; } > /tmp/ddc-parsers.$$.js
trap 'rm -f /tmp/ddc-parsers.$$.js' EXIT
gjs test-parsers.js "/tmp/ddc-parsers.$$.js"

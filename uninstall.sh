#!/usr/bin/env bash
# Remove the applet. Remove it from your panel first, via
# System Settings -> Applets, so Cinnamon drops its instance config.
set -euo pipefail

UUID="ddc-brightness@callum"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets/$UUID"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    rm -rf "$DEST"
    echo "removed $DEST"
    echo "restart Cinnamon (Alt+F2, r) to finish."
else
    echo "not installed at $DEST"
fi

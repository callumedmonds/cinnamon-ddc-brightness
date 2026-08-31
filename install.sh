#!/usr/bin/env bash
# Install the applet into Cinnamon's local applet directory.
#
#   ./install.sh            copy the files in (what you want)
#   ./install.sh --link     symlink instead, for developing on the repo
#
# The copy is the default because Cinnamon's Applets panel can only uninstall
# a real directory: pressing Uninstall on a symlinked applet removes your
# settings but leaves the applet in place.
set -euo pipefail

UUID="ddc-brightness@callum"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/files/$UUID"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets"
DEST="$DEST_DIR/$UUID"

MODE="copy"
case "${1-}" in
    --link) MODE="link" ;;
    --copy|"") MODE="copy" ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "install.sh: unknown option '$1' (try --link)" >&2; exit 2 ;;
esac

[ -d "$SRC" ] || { echo "install.sh: $SRC missing" >&2; exit 1; }

if ! command -v ddcutil >/dev/null; then
    cat >&2 <<'WARN'
warning: ddcutil is not installed; the applet will report no monitors.
         Debian/Ubuntu:  sudo apt install ddcutil
         Fedora:         sudo dnf install ddcutil
         Arch:           sudo pacman -S ddcutil
WARN
fi

mkdir -p "$DEST_DIR"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    echo "replacing previous install at $DEST"
    rm -rf "$DEST"
fi

if [ "$MODE" = "link" ]; then
    ln -s "$SRC" "$DEST"
    echo "linked  $DEST -> $SRC"
else
    cp -r "$SRC" "$DEST"
    echo "copied  $SRC -> $DEST"
fi

cat <<'NEXT'

Installed. To enable it:
  1. Restart Cinnamon:  Alt+F2, type r, Enter  (or log out and back in)
  2. System Settings -> Applets -> DDC Brightness -> add to panel

Cinnamon caches applet code, so a restart is needed after every update too --
including after a git pull with --link.
NEXT

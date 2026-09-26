#!/usr/bin/env bash
# Install mk for the current user, no root: ~/.local/bin and ~/.local/share.
#
# What lands in ~/.local/bin is a small launcher rather than a copy, pointing
# at the build — so a later `npx tauri build --no-bundle` is picked up without
# reinstalling. The desktop entry registers mk for Markdown files, so it shows
# up under "Open With" in the file manager.
set -euo pipefail
cd "$(dirname "$0")"
REPO="$PWD"

BIN="$REPO/src-tauri/target/release/mk"
if [[ ! -x "$BIN" ]]; then
  echo "No release binary at $BIN"
  echo "Build it first:  npx tauri build --no-bundle   (or ./run.sh)"
  exit 1
fi

BINDIR="$HOME/.local/bin"
APPDIR="$HOME/.local/share/applications"
ICONDIR="$HOME/.local/share/icons/hicolor"
mkdir -p "$BINDIR" "$APPDIR"

# Written, not linked — and never through an existing symlink, which would
# write to whatever it points at.
rm -f "$BINDIR/mk"
cat > "$BINDIR/mk" <<LAUNCHER
#!/bin/sh
# mk — Markdown viewer and editor with Harper. \`mk notes.md\`, \`mk -v README.md\`.
# Detached from the terminal so the shell gets its prompt back, the way
# \`code file\` and \`xdg-open\` behave; MK_FOREGROUND=1 keeps it attached.
if [ -n "\$MK_FOREGROUND" ]; then exec "$BIN" "\$@"; fi
nohup "$BIN" "\$@" >/dev/null 2>&1 &
LAUNCHER
chmod +x "$BINDIR/mk"

for pair in 32x32:32x32.png 64x64:64x64.png 128x128:128x128.png \
            256x256:128x128@2x.png 512x512:icon.png; do
  size="${pair%%:*}"
  install -Dm644 "src-tauri/icons/${pair#*:}" "$ICONDIR/$size/apps/mk.png"
done

# The launcher's absolute path, not `mk`: a desktop session's PATH is set at
# login and often lacks ~/.local/bin, and an Exec that does not resolve is a
# menu entry that silently does nothing.
sed "s|^Exec=.*|Exec=env MK_FOREGROUND=1 $BINDIR/mk %f|" mk.desktop > "$APPDIR/mk.desktop"
chmod 644 "$APPDIR/mk.desktop"

command -v update-desktop-database >/dev/null && update-desktop-database "$APPDIR" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -qtf "$ICONDIR" 2>/dev/null || true

echo "Installed:"
echo "  $BINDIR/mk -> $BIN"
echo "  $APPDIR/mk.desktop"
echo
echo "Make it the default for Markdown:  xdg-mime default mk.desktop text/markdown"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo; echo "Note: $BINDIR is not on your PATH, so \`mk file.md\` will not resolve." ;;
esac

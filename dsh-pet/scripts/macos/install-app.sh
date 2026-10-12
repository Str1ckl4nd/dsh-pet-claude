#!/bin/sh
# dsh-pet-claude on macOS, as an app.
#
#   sh scripts/macos/install-app.sh              install or update
#   DSH_PET_CLAUDE_LANG=zh sh scripts/macos/install-app.sh   labels in Chinese (or en)
#   sh scripts/macos/install-app.sh --uninstall  remove it again
#
# Installs, for the current user only:
#   ~/Applications/Claude 会话宠物.app       bring the pet up (Spotlight, Launchpad, Dock)
#   ~/Applications/关闭 Claude 会话宠物.app  close it until the next login or "Claude 会话宠物"
#   ~/Library/LaunchAgents/<label>.plist     starts the pet at login and restarts it if
#                                            it crashes; a clean close stays closed
# Logs go to ~/Library/Logs/dsh-pet-claude.log.
#
# Needs: Node.js >= 22.12, and this package built (pnpm install && pnpm run build).
set -eu

cd "$(dirname "$0")/../.."
ROOT="$(pwd -P)"
LABEL="io.github.str1ckl4nd.dsh-pet-claude"
DOMAIN="gui/$(id -u)"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APPS="$HOME/Applications"
OPEN_APP="$APPS/Claude 会话宠物.app"
QUIT_APP="$APPS/关闭 Claude 会话宠物.app"
LOG="$HOME/Library/Logs/dsh-pet-claude.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -rf "$AGENT" "$OPEN_APP" "$QUIT_APP"
  echo "removed"
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found (need >= 22.12)" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || { echo "Node.js $("$NODE" -v) is too old (need >= 22.12)" >&2; exit 1; }
[ -f "$ROOT/lib/standalone.js" ] || { echo "not built yet: run pnpm install && pnpm run build first" >&2; exit 1; }

echo "checking Electron…"
"$NODE" "$ROOT/scripts/ensure-electron.mjs"

# --- login agent -------------------------------------------------------------
# Labels follow the system language unless DSH_PET_CLAUDE_LANG (zh | en) is set
# when installing; launchd starts the pet without your shell's environment.
LANG_ENTRY=""
case "${DSH_PET_CLAUDE_LANG:-}" in
  zh|en) LANG_ENTRY="
    <key>DSH_PET_CLAUDE_LANG</key><string>$DSH_PET_CLAUDE_LANG</string>" ;;
esac
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$APPS"
cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/lib/standalone.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>$LANG_ENTRY
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

# --- icon: the pet's face from the package logo ------------------------------
ICONSET="$(mktemp -d)/pet.iconset"
mkdir -p "$ICONSET"
FACE="$(dirname "$ICONSET")/face.png"
sips -c 168 168 --cropOffset 0 44 "$ROOT/assets/logo.png" --out "$FACE" >/dev/null
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$FACE" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ "$d" -le 512 ] && sips -z "$d" "$d" "$FACE" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$(dirname "$ICONSET")/pet.icns"

# --- the two apps: a tiny bundle around a shell script each -------------------
make_app() { # path, executable name, bundle id, display name, script body
  rm -rf "$1"
  mkdir -p "$1/Contents/MacOS" "$1/Contents/Resources"
  cp "$(dirname "$ICONSET")/pet.icns" "$1/Contents/Resources/pet.icns"
  cat > "$1/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$4</string>
  <key>CFBundleDisplayName</key><string>$4</string>
  <key>CFBundleIdentifier</key><string>$3</string>
  <key>CFBundleExecutable</key><string>$2</string>
  <key>CFBundleIconFile</key><string>pet</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
  printf '%s\n' "#!/bin/sh" "LABEL=\"$LABEL\"" "AGENT=\"$AGENT\"" "DOMAIN=\"gui/\$(id -u)\"" "$5" > "$1/Contents/MacOS/$2"
  chmod +x "$1/Contents/MacOS/$2"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$1" 2>/dev/null || true
}

make_app "$OPEN_APP" open-pet "$LABEL.open" "Claude 会话宠物" '
# Bring the pet up: load the login agent if it is not loaded, start the pet if it
# is not running, and start it over if it runs without its window.
launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$DOMAIN" "$AGENT" 2>/dev/null || { sleep 2; launchctl bootstrap "$DOMAIN" "$AGENT"; }
PID=$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk "/^\tpid = /{print \$3}")
if [ -n "$PID" ] && ! pgrep -P "$PID" -f Electron >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  launchctl kickstart "$DOMAIN/$LABEL"
fi'

make_app "$QUIT_APP" quit-pet "$LABEL.quit" "关闭 Claude 会话宠物" '
# Close the pet: it shuts down cleanly, so launchd leaves it stopped (it only
# restarts a crash). The agent stays loaded, so "Claude 会话宠物" brings it back
# at once — unloading it instead made the next start wait out launchd'"'"'s throttle.
curl -s -m 3 -X POST http://127.0.0.1:3080/shutdown >/dev/null 2>&1 \
  || launchctl kill TERM "$DOMAIN/$LABEL" 2>/dev/null || true'

# --- (re)start it now ---------------------------------------------------------
# bootout returns before the old instance is gone; bootstrapping over it fails
# with an I/O error, so wait for it to go, and try once more if launchd is slow.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
i=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
launchctl bootstrap "$DOMAIN" "$AGENT" 2>/dev/null || { sleep 2; launchctl bootstrap "$DOMAIN" "$AGENT"; }
echo "installed: \"$OPEN_APP\", \"$QUIT_APP\", login agent $LABEL"

# ChatGPT Electron (Bazzite Linux)

Minimal, hardened Electron wrapper for ChatGPT.

## Prerequisites
- Node.js 18+ and npm

On Bazzite (Fedora-based):
```bash
sudo dnf install -y nodejs npm
```

## Run (dev)
```bash
cd "/home/eric/Developer/ChatGPT Electron"
npm install
npm start
```

The app opens `https://chat.openai.com/` in a dedicated window.
External links open in your default browser.

## Desktop launcher (optional)
Create a desktop entry so it shows in your app menu:
```bash
APPDIR="$HOME/.local/share/applications"
mkdir -p "$APPDIR"
cat > "$APPDIR/chatgpt-electron.desktop" <<'EOF'
[Desktop Entry]
Name=ChatGPT
Comment=ChatGPT Desktop (Electron Wrapper)
Exec=/usr/bin/env bash -lc 'cd "$HOME/Developer/ChatGPT Electron" && npm start'
Terminal=false
Type=Application
Categories=Network;Utility;
StartupWMClass=ChatGPT
EOF
update-desktop-database "$APPDIR" || true
```

## Packaging (optional)
This repo does not include a packager. You can add `electron-builder` later:
```bash
npm i -D electron-builder
```
Then configure `build` in `package.json`.

## Notes
- Node integration is disabled and context isolation is enabled.
- Navigation to `auth.openai.com` is allowed in-window for login; other sites open externally.
- Works on Linux (Bazzite), macOS, and Windows.

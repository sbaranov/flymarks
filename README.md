# Bookmarks Menu

Chrome extension that renders Bookmarks Bar entries in a Chrome-like popup menu with folder navigation, context actions, and bookmark operations.

## Quick Start

Install the extension into your main Google Chrome profile:

1. Open `chrome://extensions/` in Google Chrome.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.
5. Open the toolbar action named `Bookmarks Menu`.

After code changes, return to `chrome://extensions/` and click Reload on the `Bookmarks Menu` card.

## Development

Automated and manual development runs use **Chrome for Testing**, not your main Chrome profile. Install Chrome for Testing first if these commands fail.

```bash
npm test
```

Runs the E2E test suite in Chrome for Testing with an isolated temporary profile.

```bash
npm run browser
```

Launches Chrome for Testing with the extension loaded using a reusable manual profile at `/tmp/bookmarks-ext-manual`.

```bash
npm run browser:fresh
```

Launches Chrome for Testing with the extension loaded using a new temporary profile.

```bash
npm run icons
```

Regenerates extension icons.

### Dependencies

No npm runtime dependencies are required for the extension or tests.

Required tools on macOS:

- `node` (Node 20+ recommended)
- `curl`
- `jq`
- `unzip`
- `npm`

### Dev Loop

1. Edit extension files:
   - `manifest.json`
   - `popup.html`
   - `popup.css`
   - `popup.js`
   - `background.js`
2. If icon assets changed, regenerate:
   ```bash
   npm run icons
   ```
3. Run the automated browser test:
   ```bash
   npm test
   ```
4. Use `npm run browser` or `npm run browser:fresh` for manual development checks in Chrome for Testing.
5. Repeat.

## Install Chrome for Testing

This project uses **Chrome for Testing** for automation and manual development checks. Install it as a per-user macOS app so it survives reboots and temporary-directory cleanup:

```text
$HOME/Applications/Google Chrome for Testing.app
```

### macOS (Apple Silicon)

```bash
mkdir -p "$HOME/Applications"
tmp_dir=$(mktemp -d /tmp/chrome-for-testing-download.XXXXXX)
cd "$tmp_dir"

curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json -o versions.json
url=$(jq -r '.channels.Stable.downloads.chrome[] | select(.platform=="mac-arm64") | .url' versions.json)
curl -fL "$url" -o chrome-mac-arm64.zip
unzip -q -o chrome-mac-arm64.zip
rm -rf "$HOME/Applications/Google Chrome for Testing.app"
ditto 'chrome-mac-arm64/Google Chrome for Testing.app' "$HOME/Applications/Google Chrome for Testing.app"
```

Binary path:

```text
$HOME/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

### macOS (Intel)

Use platform `mac-x64` instead of `mac-arm64` in the `jq` query, and replace `chrome-mac-arm64` with `chrome-mac-x64` in the zip filename and `ditto` source path.

## Manual Verification in Main Chrome

For final visual checks, use your normal Google Chrome profile rather than Chrome for Testing. This matches the real toolbar, bookmarks bar, favicon cache, and extension popup context.

1. Open `chrome://extensions/` in Google Chrome.
2. Ensure Developer mode is on.
3. If `Bookmarks Menu` is already listed, click its Reload button.
4. If it is not listed, click Load unpacked and select the current repository checkout.
5. Open the toolbar action named `Bookmarks Menu` to inspect the popup.
6. If the card shows an Errors button, open it, inspect whether the errors are current or stale, clear stale errors, reload the extension, and reopen the popup to verify the button stays gone.

Ad hoc Chrome screenshots should be named `chrome-*.png`; this convention is ignored by git.

## Important Caveats

- Stable Google Chrome may ignore `--load-extension`/`--disable-extensions-except` automation flags in some environments, so use Chrome for Testing for automated and reproducible development runs.
- `npm test` validates core interactions (render, open, context action, reorder, folder navigation). It is not a pixel-perfect visual diff test.
- The extension uses Chrome APIs (`chrome.bookmarks`, `chrome.tabs`, `chrome.windows`) and must run as an unpacked extension in a Chromium-based browser.

## Browser Testing Architecture Notes

This section documents the key constraints and decisions behind the E2E browser test environment.

### 1. Sandbox and process constraints

- Running real browser automation from the default sandbox was unreliable (browser process could abort or fail to expose DevTools).
- E2E browser runs should be executed with elevated permissions in this environment.

### 2. Stable Google Chrome is not suitable for unpacked-extension automation here

- In some setups, stable Google Chrome logs:
  - `--load-extension is not allowed in Google Chrome, ignoring.`
  - `--disable-extensions-except is not allowed in Google Chrome, ignoring.`
- Impact: the extension is not loaded, so popup/extension targets are unavailable to CDP.
- Decision: use **Chrome for Testing** for E2E runs.

### 3. Keychain prompt behavior

- macOS may prompt for Keychain access when launching browser automation.
- If access is denied, browser startup can fail.
- Mitigation: always launch automated runs with `--use-mock-keychain`.

### 4. CDP transport requirement in Node

- The test runner requires WebSocket support for CDP.
- Use Node with:
  - `npm test`

### 5. Extension ID discovery strategy

- Relying on a single discovery mechanism can be flaky.
- Implemented strategy:
  1. Try CDP target discovery (`service_worker` URL ending in `/background.js`).
  2. Fallback to profile-based extension metadata lookup.

### 6. Flake-resistance patterns in tests

- Use polling for async bookmark operations (e.g., delete verification) instead of fixed short sleeps.
- Use a dynamically allocated free remote-debugging port per run to avoid collisions.
- Synthetic drag-and-drop via CDP can be unreliable; deterministic test hooks are used for reorder verification.

### 7. Browser installation model

- Chrome for Testing should be installed at `$HOME/Applications/Google Chrome for Testing.app` so multiple workspaces can reuse it and it survives reboots.
- The repository intentionally does not commit browser binaries.

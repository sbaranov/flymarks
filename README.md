# Bookmarks Menu

Chrome extension that renders Bookmarks Bar entries in a Chrome-like popup menu with folder navigation, context actions, and bookmark operations.

## Install Chrome for Testing

This project uses **Chrome for Testing** for automation (not your personal Chrome profile).
Install it as a per-user macOS app so it survives reboots and temporary-directory cleanup:

```text
/Users/stas/Applications/Google Chrome for Testing.app
```

### macOS (Apple Silicon)

```bash
mkdir -p /Users/stas/Applications /tmp/chrome-for-testing-download
cd /tmp/chrome-for-testing-download

curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json -o versions.json
url=$(jq -r '.channels.Stable.downloads.chrome[] | select(.platform=="mac-arm64") | .url' versions.json)
curl -fL "$url" -o chrome-mac-arm64.zip
rm -rf chrome-mac-arm64
unzip -q -o chrome-mac-arm64.zip
rm -rf '/Users/stas/Applications/Google Chrome for Testing.app'
ditto 'chrome-mac-arm64/Google Chrome for Testing.app' '/Users/stas/Applications/Google Chrome for Testing.app'
```

Binary path:

```text
/Users/stas/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

### macOS (Intel)

Use platform `mac-x64` instead of `mac-arm64` in the `jq` query, and replace `chrome-mac-arm64` with `chrome-mac-x64` in the zip filename and `ditto` source path.

## Run Extension Test

Use Chrome for Testing for automated or reproducible extension tests. Use default Google Chrome only for final visual verification against the real toolbar, bookmarks bar, favicon cache, and installed-profile context.

From project root:

```bash
cd /path/to/bookmarks
HEADLESS=0 \
node --experimental-websocket tests/run-chrome-test.mjs
```

Expected success output:

```text
PASS: Extension UI and interactions verified in live browser: ...
```

## Notes

- Test runner uses an isolated temporary profile (`--user-data-dir`), so it does not touch your normal browser data.
- Runner enables `--use-mock-keychain` to avoid Keychain unlock prompts.
- If `BROWSER_BIN` is not set, runner uses `/Users/stas/Applications/Google Chrome for Testing.app`.
- If you want to regenerate toolbar icons:

```bash
node tests/generate-icons.mjs
```

## Development Process

### Dependencies

No npm runtime dependencies are required for the extension or tests.

Required tools on macOS:

- `node` (Node 20+ recommended)
- `curl`
- `jq`
- `unzip`

Optional:

- `npm` (only for convenience scripts if you add them later)

### Dev Loop

1. Edit extension files:
   - `manifest.json`
   - `popup.html`
   - `popup.css`
   - `popup.js`
   - `background.js`
2. If icon assets changed, regenerate:
   ```bash
   node tests/generate-icons.mjs
   ```
3. Run the automated browser test:
   ```bash
   HEADLESS=0 \
   node --experimental-websocket tests/run-chrome-test.mjs
   ```
4. Repeat.

### Manual Testing: Chrome for Testing

If you want to inspect UI manually while developing, launch Chrome for Testing with:

```bash
'/Users/stas/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  --use-mock-keychain \
  --user-data-dir=/tmp/bookmarks-ext-manual \
  --load-extension="$PWD"
```

### Visual Verification: Default Chrome

For final visual checks, use the user's normal Google Chrome profile rather than Chrome for Testing. This matches the real toolbar, bookmarks bar, favicon cache, and extension popup context.

1. Open `chrome://extensions/` in Google Chrome.
2. Ensure Developer mode is on.
3. If `Bookmarks Menu` is already listed, click its Reload button.
4. If it is not listed, click Load unpacked and select the current repository checkout.
5. Open the toolbar action named `Bookmarks Menu` to inspect the popup.
6. If the card shows an Errors button, open it, inspect whether the errors are current or stale, clear stale errors, reload the extension, and reopen the popup to verify the button stays gone.

Ad hoc Chrome screenshots should be named `chrome-*.png`; this convention is ignored by git.

### Important Caveats

- Stable Google Chrome on this machine blocks `--load-extension`/`--disable-extensions-except` in this automation setup, so use Chrome for Testing.
- Test runner validates core interactions (render, open, context action, reorder, folder navigation). It is not a pixel-perfect visual diff test.
- The extension uses Chrome APIs (`chrome.bookmarks`, `chrome.tabs`, `chrome.windows`) and must run as an unpacked extension in a Chromium-based browser.

## Browser Testing Architecture Notes

This section documents the key constraints and decisions behind the E2E browser test environment.

### 1. Sandbox and process constraints

- Running real browser automation from the default sandbox was unreliable (browser process could abort or fail to expose DevTools).
- E2E browser runs should be executed with elevated permissions in this environment.

### 2. Stable Google Chrome is not suitable for unpacked-extension automation here

- In this setup, stable Google Chrome logs:
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
  - `node --experimental-websocket tests/run-chrome-test.mjs`

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

- Chrome for Testing should be installed at `/Users/stas/Applications/Google Chrome for Testing.app` so multiple workspaces can reuse it and it survives reboots.
- The repository intentionally does not commit browser binaries.

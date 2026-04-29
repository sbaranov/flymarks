# Bookmarks Menu

Chrome extension that renders Bookmarks Bar entries in a Chrome-like popup menu with folder navigation, context actions, and bookmark operations.

## Quick Start

Install the development extension into your main Google Chrome profile:

1. Open `chrome://extensions/` in Google Chrome.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.
5. Open the toolbar action named `Bookmarks Menu`.

After code changes, return to `chrome://extensions/` and click Reload on the `Bookmarks Menu` card. If the card shows an Errors button, inspect whether the errors are current or stale, clear stale errors, and reload the extension to verify the button stays gone.

## Development

Automated tests run in **Chrome for Testing**, not your main Chrome profile.

Required tools on macOS:

- `node` (Node 20+ recommended)

Install Chrome for Testing:

```bash
version=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE)
curl -fL "https://storage.googleapis.com/chrome-for-testing-public/$version/mac-arm64/chrome-mac-arm64.zip" -o /tmp/chrome-mac-arm64.zip
unzip -q -o /tmp/chrome-mac-arm64.zip -d /tmp/chrome-for-testing
rm -rf "$HOME/Applications/Google Chrome for Testing.app"
mv "/tmp/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app" "$HOME/Applications/"
```

Run the E2E test suite in Chrome for Testing with an isolated temporary profile:

```bash
npm test
```

Launch Chrome for Testing for manual testing using a reusable persistent profile:

```bash
npm run browser
```

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
- Mitigation: use **Chrome for Testing** for E2E runs.

### 3. Keychain prompt behavior

- macOS may prompt for Keychain access when launching browser automation.
- If access is denied, browser startup can fail.
- Mitigation: always launch automated runs with `--use-mock-keychain`.

### 4. CDP transport requirement in Node

- The test runner requires WebSocket support for CDP.
- Mitigation: use Node with `--experimental-websocket`.

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

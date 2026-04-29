# Flymarks

Flymarks is a lightweight Chrome extension that shows bookmarks as a clean and compact dropdown menu, with folder navigation, context actions, and bookmark operations.

It is open source so you can verify that it does not send your bookmark data anywhere.

![Flymarks banner](assets/banner.png)

## Quick Start

Install the development extension into your main Google Chrome profile:

1. Open `chrome://extensions/` in Google Chrome.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.
5. Open the toolbar action named `Flymarks`.

After code changes, return to `chrome://extensions/` and click Reload on the `Flymarks` card. If the card shows an Errors button, inspect whether the errors are current or stale, clear stale errors, and reload the extension to verify the button stays gone.

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

### Agent Workflow

If you use Codex or Claude Code, this project pairs well with the optional [Chrome Extension skill](https://github.com/sbaranov/chrome-extension-skill). The skill captures the Chrome extension testing, packaging, screenshot, privacy, and Chrome Web Store workflow used by this repo.

## Publishing

Create a Chrome Web Store upload package:

```bash
npm run package
```

This writes `dist/flymarks.zip` with `manifest.json` at the archive root.

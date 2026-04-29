import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findChromeForTesting(repoDir = path.resolve(process.cwd())) {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;

  const executableRelativePath = process.platform === 'darwin'
    ? 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    : 'chrome-linux64/chrome';
  const installDirs = [
    path.join(os.homedir(), '.cache/chrome'),
    path.join(repoDir, 'chrome'),
  ];

  for (const installDir of installDirs) {
    if (!fs.existsSync(installDir)) continue;

    const candidates = fs.readdirSync(installDir)
      .map((name) => path.join(installDir, name, executableRelativePath))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

    if (candidates.length > 0) {
      return candidates[candidates.length - 1];
    }
  }

  const homeInstall = path.join(
    os.homedir(),
    'Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
  if (process.platform === 'darwin' && fs.existsSync(homeInstall)) return homeInstall;

  throw new Error(
    'Chrome for Testing was not found. Run: npx @puppeteer/browsers install chrome@stable --path ~/.cache',
  );
}

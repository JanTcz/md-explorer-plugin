// Opens a URL in the person's default browser.

import { spawn } from 'node:child_process';

/** Opens `url` in the default browser; resolves whether a launcher could be started. */
export function openBrowser(url, platform = process.platform, launch = spawn) {
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise(resolve => {
    const child = launch(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

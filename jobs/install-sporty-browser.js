'use strict';
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {configureBrowserPath} = require('../lib/sportyBrowserRuntime');

function installBrowser({env = process.env, withDependencies = false, force = false,
  spawn = spawnSync, resolvePackage = () => require.resolve('playwright/package.json'),
  log = console.log, error = console.error} = {}) {
  const h2hEnabled=env.SPORTYBET_H2H_WORKER==='true';
  if (!h2hEnabled && !force && !withDependencies && String(env.SPORTYBET_BOOKING_MODE || 'public').trim().toLowerCase() === 'public') {
    log('[SportyBet browser] Anonymous booking enabled; H2H uses the separate worker; Chromium is not required on the web server.');
    return 0;
  }
  if (env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
    log('[SportyBet browser] Download skipped by PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1. A prepared browser is required.');
    return 0;
  }
  try {
    const cli = path.join(path.dirname(resolvePackage()), 'cli.js');
    const browserEnv = configureBrowserPath({...env});
    log('[SportyBet browser] Installing the pinned Chromium browser for public H2H checks and optional session recovery.');
    const result = spawn(process.execPath, [cli, 'install', ...(withDependencies ? ['--with-deps'] : []), 'chromium'],
      {stdio:'inherit', env:browserEnv});
    if (result.error || result.status !== 0) {
      error('[SportyBet browser] Installation failed. H2H checks and browser sign-in need Chromium; see SPORTYBET_AUTOMATIC_SESSION.md.');
      return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    }
    log('[SportyBet browser] Chromium is ready for public H2H checks and optional session recovery.');
    return 0;
  } catch {
    error('[SportyBet browser] Could not run the pinned Playwright installer. Install the project dependencies and retry.');
    return 1;
  }
}

if (require.main === module) process.exitCode = installBrowser({withDependencies:process.argv.includes('--with-deps'),force:process.argv.includes('--force')});
module.exports = {installBrowser};

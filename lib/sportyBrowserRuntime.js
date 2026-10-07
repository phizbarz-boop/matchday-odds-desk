'use strict';

// Keep Chromium in the deployed package by default, so Render's build and
// runtime use the same browser. Docker or a prepared host can override this.
function configureBrowserPath(env = process.env) {
  if (!env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = '0';
  return env;
}

module.exports = {configureBrowserPath};

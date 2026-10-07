'use strict';
// Run locally. The user signs in through SportyBet's own form, which handles
// its current encryption/challenges. Export only the session cookies needed
// by the server; never print credentials or cookies to the terminal.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

function bootstrapLine(cookies, now = Date.now()) {
  const required = ['accessToken', 'refreshToken', 'device-id', 'deviceId'];
  const selected = new Map();
  for (const cookie of cookies || []) {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!['sportybet.com', 'www.sportybet.com'].includes(domain) || !required.includes(cookie.name)) continue;
    if (cookie.expires > 0 && cookie.expires * 1000 <= now) continue;
    if (!cookie.value || /[;\r\n]/.test(cookie.value)) continue;
    selected.set(cookie.name, cookie.value);
  }
  if (!selected.has('accessToken') || !selected.has('refreshToken')) {
    throw new Error('The dummy account has no usable accessToken/refreshToken cookies. Finish signing in, then retry.');
  }
  return 'SPORTYBET_BOOTSTRAP_COOKIES=' + required.filter(name => selected.has(name)).map(name => `${name}=${selected.get(name)}`).join('; ');
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this helper in your own interactive terminal.');
  let chromium;
  try { ({chromium} = require('playwright')); }
  catch { throw new Error('Install the local helper dependency: npm install --no-save --package-lock=false playwright, then npx playwright install chromium.'); }
  const browser = await chromium.launch({headless:false});
  const input = readline.createInterface({input:process.stdin, output:process.stdout});
  try {
    const context = await browser.newContext({locale:'en-NG'});
    const page = await context.newPage();
    await page.goto('https://www.sportybet.com/ng/', {waitUntil:'domcontentloaded', timeout:45000});
    await input.question('Sign in to your DUMMY account in the opened SportyBet window. Return here and press Enter after signing in. ');
    bootstrapLine(await context.cookies('https://www.sportybet.com/ng/'));
    const check = await context.request.get('https://www.sportybet.com/api/ng/patron/account/info', {
      headers:{clientid:'web', operid:'2', platform:'web', Referer:'https://www.sportybet.com/ng/'}, timeout:20000,
    });
    let payload;
    try { payload = await check.json(); } catch { /* blocked/non-JSON */ }
    if (!check.ok() || Number(payload?.bizCode) !== 10000) {
      throw new Error('SportyBet did not verify this dummy session. Complete any sign-in challenge in the browser and retry.');
    }
    const line = bootstrapLine(await context.cookies('https://www.sportybet.com/ng/'));
    const output = path.join(process.cwd(), '.sportybet-bootstrap.env');
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, line + '\n', {mode:0o600, flag:'wx'});
    fs.renameSync(temporary, output);
    console.log('Verified dummy session saved to .sportybet-bootstrap.env. In Render, set SPORTYBET_BOOTSTRAP_COOKIES to the text after the first =, then restart/deploy. Keep this file private.');
  } finally { input.close(); await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {bootstrapLine};

/*
 * The interaction check.
 *
 * Two things on this page answer to a finger, and neither can be verified by
 * reading the source: the legend's caret, and the water. The second one in
 * particular is a judgement — "the krill should avoid the tap a little" — and
 * the first attempt at it swept a clean empty hole through the field, which
 * looked nothing like a little and was only discovered by taking the picture.
 *
 * So this drags a pointer across the water and photographs the same small crop
 * three times: before, immediately after, and once it has settled. Read
 * together they answer the only question that matters — does the field *part*
 * and come back, or does it get deleted.
 *
 * Usage:  node scripts/interact.js      (run `npm run build` in app/ first)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
const root = new URL('../app/dist/', import.meta.url).pathname;
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    .replace(/^\/kujirabtc/, '');
  if (path === '/' || path === '') path = '/index.html';
  try {
    const body = await readFile(join(root, normalize(path)));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('ERROR:', e.message));
await page.goto(`http://127.0.0.1:${port}/kujirabtc/?res=96&scale=0.5`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 600000 });

// Nothing can be judged against an empty ocean, so wait for a tape — the real
// one if this machine can reach Binance, the stand-in if it cannot.
await page.waitForFunction(
  () => document.querySelector('.feed-label')?.textContent !== '接続中',
  null, { timeout: 600000 },
);
await page.waitForTimeout(6000);
console.log('feed:', await page.textContent('.feed-label'));

// The caret, both ways.
console.log('legend at start:', await page.getAttribute('.legend', 'data-open'));
await page.click('.legend-toggle');
console.log('after one click:', await page.getAttribute('.legend', 'data-open'),
  'aria-expanded:', await page.getAttribute('.legend-toggle', 'aria-expanded'));
await page.click('.legend-toggle');
console.log('after two clicks:', await page.getAttribute('.legend', 'data-open'));
await page.click('.legend-toggle');

const clip = { x: 95, y: 400, width: 200, height: 200 };
await page.screenshot({ path: 'shots/tap-before.png', clip, timeout: 180000 });
await page.mouse.move(195, 500);
await page.mouse.down();
for (let i = 0; i < 10; i++) {
  await page.mouse.move(195 + i * 6, 500 + i * 3);
  await page.waitForTimeout(80);
}
await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/tap-after.png', clip, timeout: 180000 });
// Long enough for the fluid's six-second memory to have mostly given up.
await page.waitForTimeout(3500);
await page.screenshot({ path: 'shots/tap-settle.png', clip, timeout: 180000 });
console.log('wrote shots/tap-{before,after,settle}.png');

await browser.close();
server.close();

/*
 * The capture loop.
 *
 * A piece meant to be watched for an hour cannot be judged from the frame it
 * happens to be on when you look. This drives a real browser at a phone's own
 * size, waits out the warm-up, and takes a still every few seconds — so what
 * gets looked at is a *sample* of the piece rather than its first impression.
 *
 * Usage:  node scripts/capture.js [--shots 6] [--every 4] [--device portrait]
 *
 * It serves app/dist, so run `npm run build` in app/ first.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? '1']),
);
const SHOTS = Number(args.shots ?? 6);
const EVERY = Number(args.every ?? 4);
const OUT = args.out ?? 'shots';

// Portrait first: this is the shape the piece is composed for.
const DEVICES = {
  portrait: { width: 390, height: 844, deviceScaleFactor: 2 },
  tall: { width: 412, height: 915, deviceScaleFactor: 2 },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
};
const view = DEVICES[args.device ?? 'portrait'];

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
};

const root = new URL('../app/dist/', import.meta.url).pathname;
const server = createServer(async (req, res) => {
  // The app is built with base=/kujirabtc/, so that prefix is stripped here and
  // the file is served from dist as if it were the site root.
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
  // The environment ships a Chromium that may not match the version this
  // Playwright expects; PLAYWRIGHT_CHROMIUM points at the one that is here.
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  args: [
    // Headless Chromium has no GPU, and without these the WebGL context simply
    // fails to create and every capture is a black rectangle.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: view, deviceScaleFactor: view.deviceScaleFactor });
page.on('console', (m) => {
  if (m.type() === 'error' || m.text().includes('[')) console.log('  page:', m.text());
});
page.on('pageerror', (e) => console.log('  ERROR:', e.message));

const query = args.query ?? 'res=96&scale=0.5';
await page.goto(`http://127.0.0.1:${port}/kujirabtc/?${query}`, { waitUntil: 'load' });

// The warm-up runs six seconds of simulation in slices before the reveal, and
// the feed needs eight before it gives up on Binance and falls back.
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 600000 });
console.log('warm-up complete');

for (let i = 0; i < SHOTS; i++) {
  await page.waitForTimeout(EVERY * 1000);
  const file = `${OUT}/${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path: file, timeout: 180000, animations: 'disabled' });
  const stats = await page.evaluate(() => ({
    price: document.querySelector('.price-value')?.textContent,
    feed: document.querySelector('.feed-label')?.textContent,
    rate: document.querySelector('.rate')?.textContent,
  }));
  console.log(file, JSON.stringify(stats));
}

await browser.close();
server.close();

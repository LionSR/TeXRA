// Screenshot every harness scene: node shoot.mjs [outDir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'shots');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(
  process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {},
);
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
});
// Fixture timestamps sit near the epoch; pin the page clock beside them
// (fanOutScenario BOARD_NOW) so elapsed labels read as minutes, not decades.
await page.clock.setFixedTime(10_000_000);
const origin = `http://localhost:${process.env.PORT ?? 5178}`;
let scenes = process.env.SCENES?.split(',');
if (!scenes) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  scenes = (await page.locator('html').getAttribute('data-scenes')).split(',');
}
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});
for (const scene of scenes) {
  await page.goto(`${origin}/?scene=${scene}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#frame');
  await page.waitForTimeout(800);
  await page
    .locator('#frame')
    .screenshot({ path: resolve(out, `${scene}.png`) });
  console.log('shot', scene);
}
await browser.close();

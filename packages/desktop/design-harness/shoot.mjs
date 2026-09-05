// Screenshot every harness scene: node shoot.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'shots');
mkdirSync(out, { recursive: true });
const scenes = process.env.SCENES
  ? process.env.SCENES.split(',')
  : [
      'ext-new',
      'ext-session',
      'ext-drawer',
      'ext-proposal',
      'ext-inline',
      'run-board',
      'desktop-papers',
      'desktop-switcher',
      'desktop-subagents',
      'desktop-run',
    ];
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
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});
for (const scene of scenes) {
  await page.goto(
    `http://localhost:${process.env.PORT ?? 5178}/?scene=${scene}`,
    {
      waitUntil: 'networkidle',
    },
  );
  await page.waitForSelector('#frame');
  await page.waitForTimeout(800);
  await page
    .locator('#frame')
    .screenshot({ path: resolve(out, `${scene}.png`) });
  console.log('shot', scene);
}
await browser.close();

/**
 * Standardized per-suite fake platform override.
 *
 * `vitest.config.mjs` installs a default `createFakePlatform()` before every
 * test file (see `setupFakePlatform.ts`), so most suites need nothing else.
 * Suites that need custom options/overrides (a seeded workspace, a real
 * `nodeFilesystem`, stubbed secrets, etc.) should call `setupPlatform(...)`
 * once — at module scope or inside a `describe` — instead of hand-wiring
 * `initPlatform(createFakePlatform(...))` in a `beforeAll`/`beforeEach`. It
 * installs the requested platform before each test in the current suite and
 * restores the suite-default fake platform afterward, so overrides never
 * leak into later tests in the same file.
 */
import { afterEach, beforeEach } from 'vitest';

import type { Platform } from '@platform/platform';
import { createFakePlatform, type FakePlatformOptions } from './FakePlatform';

type PlatformBuilder = () => Platform | Promise<Platform>;

/**
 * Installs a fake platform right now. `initPlatform` is restricted to
 * composition roots by lint, so this is the one place test helpers reach for
 * it dynamically — suites needing an ad hoc, one-off platform install
 * (rather than the standard per-test `setupPlatform` wiring below) should
 * call this instead of hand-rolling the dynamic import.
 */
export async function installPlatform(
  options: FakePlatformOptions = {},
  overrides: Partial<Platform> = {},
): Promise<void> {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform(options, overrides));
}

/**
 * Installs a fake platform for every test in the current suite.
 *
 * Pass `FakePlatformOptions`/`Partial<Platform>` overrides for the common
 * case — a fresh `createFakePlatform(options, overrides)` is built for every
 * test. Pass a builder function instead when the platform must be computed
 * per test (a real `nodeFilesystem`, a per-test temp dir, captured state from
 * an earlier step, etc.).
 */
export function setupPlatform(
  optionsOrBuilder: FakePlatformOptions | PlatformBuilder = {},
  overrides: Partial<Platform> = {},
): void {
  const buildPlatform: PlatformBuilder =
    typeof optionsOrBuilder === 'function'
      ? optionsOrBuilder
      : () => createFakePlatform(optionsOrBuilder, overrides);

  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(await buildPlatform());
  });

  afterEach(async () => {
    await installPlatform();
  });
}

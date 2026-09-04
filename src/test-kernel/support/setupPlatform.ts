/**
 * Standardized per-suite fake platform override.
 *
 * `vitest.config.mjs` installs a default `createFakePlatform()` (and its
 * workspace roots) before every test file (see `setupFakePlatform.ts`), so
 * most suites need nothing else. Suites that need custom options/overrides (a
 * seeded workspace, a real `nodeFilesystem`, stubbed secrets, etc.) should
 * call `setupPlatform(...)` once, at module scope or inside a `describe`,
 * instead of hand-wiring `initPlatform(...)` in a `beforeAll`/`beforeEach`.
 * It installs the requested platform before each test in the current suite
 * and restores the suite-default fake platform afterward, so overrides never
 * leak into later tests in the same file.
 */
import { afterEach, beforeEach } from 'vitest';

import type { Platform } from '@platform/platform';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  createFakePlatform,
  createFakeWorkspaceRoots,
  type FakeHostOverrides,
  type FakePlatformOptions,
} from './FakePlatform';

/** A process platform and the workspace roots installed beside it. */
export interface FakeHost {
  readonly platform: Platform;
  readonly roots: WorkspaceRoots;
}

type HostBuilder = () => FakeHost | Promise<FakeHost>;

/** Build both halves of a fake host from one option bag. */
export function createFakeHost(
  options: FakePlatformOptions = {},
  overrides: FakeHostOverrides = {},
): FakeHost {
  const { config, workspaceState, ...platformOverrides } = overrides;
  return {
    platform: createFakePlatform(options, platformOverrides),
    roots: createFakeWorkspaceRoots(options, { config, workspaceState }),
  };
}

/**
 * Installs a fake host right now. `initPlatform` is restricted to composition
 * roots by lint, so this is the one place test helpers reach for it; suites
 * needing an ad hoc, one-off install (rather than the standard per-test
 * `setupPlatform` wiring below) call this instead.
 *
 * Both platform modules are imported at call time, not statically: a suite
 * that calls `vi.resetModules()` gets fresh module instances, and the install
 * must land in the instances the code under test will import next.
 */
export async function installFakeHost(host: FakeHost): Promise<void> {
  const [{ initPlatform }, { initProcessWorkspaceRoots }] = await Promise.all([
    import('@platform/platform'),
    import('@platform/workspaceRoots'),
  ]);
  initPlatform(host.platform);
  initProcessWorkspaceRoots(host.roots);
}

/** Installs a fake host built from `options`/`overrides` right now. */
export async function installPlatform(
  options: FakePlatformOptions = {},
  overrides: FakeHostOverrides = {},
): Promise<void> {
  await installFakeHost(createFakeHost(options, overrides));
}

/**
 * Installs a fake host for every test in the current suite.
 *
 * Pass `FakePlatformOptions`/`FakeHostOverrides` for the common case: a
 * fresh fake host is built for every test. Pass a builder function instead
 * when the host must be computed per test (a real `nodeFilesystem`, a
 * per-test temp dir, captured state from an earlier step, etc.).
 */
export function setupPlatform(
  optionsOrBuilder: FakePlatformOptions | HostBuilder = {},
  overrides: FakeHostOverrides = {},
): void {
  const buildHost: HostBuilder =
    typeof optionsOrBuilder === 'function'
      ? optionsOrBuilder
      : () => createFakeHost(optionsOrBuilder, overrides);

  beforeEach(async () => {
    await installFakeHost(await buildHost());
  });

  afterEach(async () => {
    await installPlatform();
  });
}

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
// The two services by their own modules, not the package barrel: a setup
// file loads before a suite's `vi.mock` registrations, and the barrel would
// cache `NodeChildProcessSpawner`'s `node:child_process` ahead of a suite
// that mocks it.
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { afterEach, beforeEach } from 'vitest';

import type { ToolInjections } from '@agent/runtime/toolInjection';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { ProcessServices } from '@platform/processRuntime';
import type { AppState } from '@platform/interfaces';
import type { Platform } from '@platform/platform';
import type { PlatformSecrets, Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import type { SetupPlatform, SetupPlatformShape } from '@tools/setup/platform';
import {
  createFakePlatform,
  createFakeWorkspaceRoots,
  FakeSecrets,
  type FakeHostOverrides,
  type FakePlatformOptions,
} from './FakePlatform';
import type { Layer } from 'effect';

/**
 * A process platform and the workspace roots installed beside it, plus the
 * setup platform a setup-tool suite provides (absent on every other host:
 * a setup-tool call there is a test error).
 */
export interface FakeHost {
  readonly platform: Platform;
  readonly roots: WorkspaceRoots;
  /** The store the host's `Secrets` service reads, as a root's own local. */
  readonly secrets: PlatformSecrets;
  readonly setup?: SetupPlatformShape;
}

type HostBuilder = () => FakeHost | Promise<FakeHost>;

/** Build both halves of a fake host from one option bag. */
export function createFakeHost(
  options: FakePlatformOptions = {},
  overrides: FakeHostOverrides = {},
): FakeHost {
  const {
    config,
    workspaceState,
    globalState,
    secrets,
    setup,
    ...platformOverrides
  } = overrides;
  return {
    platform: createFakePlatform(options, platformOverrides),
    roots: createFakeWorkspaceRoots(options, {
      config,
      workspaceState,
      globalState,
    }),
    secrets: secrets ?? new FakeSecrets(options.secrets, options.secretsEnv),
    ...(setup ? { setup } : {}),
  };
}

/**
 * The host most recently installed. The process runtime below is built once
 * per module instance while hosts are swapped per test, so its process
 * services resolve against this binding on every call, exactly as the
 * production roots' thunks resolve against their own locals.
 */
let current: FakeHost | undefined;

export function installedHost(): FakeHost {
  if (!current) throw new Error('No fake host is installed.');
  return current;
}

/**
 * The installed fake host's two process stores, as the model-option and CLI
 * history readers take them. Read per call, not captured: a suite that
 * reinstalls its host mid-test sees the new one.
 */
export function hostStores(): ModelOptionStores {
  const { secrets, roots } = installedHost();
  return { secrets, globalState: roots.globalState };
}

function installedSetup(): SetupPlatformShape {
  const { setup } = installedHost();
  if (!setup) {
    throw new Error(
      'The installed fake host has no setup platform: pass `setup` in the host overrides.',
    );
  }
  return setup;
}

/**
 * The `SetupPlatform` service of every test runtime: each member reads the
 * installed host's `setup` when called, so a suite that swaps hosts per test
 * swaps setup platforms with them.
 */
export const fakeSetupPlatform: SetupPlatformShape = {
  get host() {
    return installedSetup().host;
  },
  signIn: () => installedSetup().signIn(),
  get commands() {
    return installedSetup().commands;
  },
  get extensions() {
    return installedSetup().extensions;
  },
  get terminal() {
    return installedSetup().terminal;
  },
};

/** The process services a fake host provides to a program. */
export type FakeProcessServices = ProcessServices;

type FakeProcessServicesLayer = Layer.Layer<FakeProcessServices>;

let processServices: FakeProcessServicesLayer | undefined;

/**
 * The process services over the installed fake host, as
 * `installFakeHost` builds them for the bare runtime: for a suite that builds
 * a process runtime of its own, or runs a program that requires them under
 * `it.effect`. Available once the first fake host is installed, which the
 * kernel's setup file does before every test.
 */
export function fakeProcessServices(): FakeProcessServicesLayer {
  if (!processServices) {
    throw new Error(
      'No fake host is installed: the process services are built with the first install.',
    );
  }
  return processServices;
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
  const [
    { initPlatform },
    { initProcessWorkspaceRoots },
    { effectRuntime, initProcessRuntime },
    { installAuthProgramEdge },
    { Layer, ManagedRuntime },
    { testHttpClientLayer },
    { Secrets },
    { AppState },
    { SetupPlatform },
    { ToolInjections },
  ] = await Promise.all([
    import('@platform/platform'),
    import('@platform/workspaceRoots'),
    import('@platform/processRuntime'),
    import('@auth/authProgram'),
    import('effect'),
    import('@test/support/fetchTestUtils'),
    import('@platform/secrets'),
    import('@platform/interfaces'),
    import('@tools/setup/platform'),
    import('@agent/runtime/toolInjection'),
  ]);
  current = host;
  // The process services, over whichever host is installed when a member is
  // called: hosts change per test, the runtime does not. These imports
  // stay eager: the process runtime is built synchronously by
  // `effectRuntime().runSync` callers, so a lazily imported (asynchronous)
  // layer here fails every one of them.
  processServices ??= Layer.mergeAll(
    testHttpClientLayer,
    // The same standard-library filesystem and path services the process
    // roots provide, over the real temp roots the harness runs on.
    NodeFileSystem.layer,
    NodePath.layer,
    Layer.mock(UpdateCheckRecords, {}),
    Layer.mock(InquiryRecords, {}),
    Secrets.layer(() => installedHost().secrets),
    AppState.layer(() => installedHost().roots.globalState),
    SetupPlatform.layer(fakeSetupPlatform),
    // No conditional injections on the bare fake host: a suite that
    // exercises them passes its own list to `resolveAgentTools`.
    ToolInjections.layer([]),
  );
  initPlatform(host.platform);
  initProcessWorkspaceRoots(host.roots);
  // A bare process runtime for the Promise-facing boundaries that run
  // fibers (the loopback sign-in). The session graph family is not installed
  // here: `sessionGraphTestSetup` loads the graph's production modules, and
  // a suite imports it (through `sessionTestUtils` or
  // `defaultSessionTestSetup`) after its own `vi.mock` registrations, which
  // this install, called from a setup file or a `beforeEach`, cannot promise.
  try {
    effectRuntime();
  } catch {
    initProcessRuntime(ManagedRuntime.make(processServices));
  }
  // The auth run edge, unconditionally: a suite that reset modules gets a
  // fresh `@auth/authProgram` instance, and this install must land on it.
  installAuthProgramEdge((program) => effectRuntime().runPromiseExit(program));
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

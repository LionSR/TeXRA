/**
 * The fake host a suite runs over: the record (`createFakeHost`), the host
 * installed now (`installedHost`; `FakeHost.layer` in `testKernel.ts`
 * installs one for a block or a test), and the ports a test process serves
 * over it, each reading the installed host when it is called. Nothing is
 * installed by default: a suite that reads a host states it with
 * `FakeHost.layer`.
 */
import { Effect, Layer, type Scope } from 'effect';

import type { AgentDirectoriesPort } from '@platform/interfaces';
import { GlobalValues } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { GlobalDatabase } from '@shared/session/database';
import type { SetupPlatformShape } from '@texra/tools/setup/platform';
import {
  createFakePlatform,
  createFakeWorkspaceRoots,
  FakeSecrets,
  HARNESS_APP,
  type TestApp,
  type FakeHostOverrides,
  type FakeProcessPorts,
  type FakePlatformOptions,
} from './FakePlatform';
import type { StateStore } from '@texra-ai/harness/host';

/** The process's `GlobalValues` over a global database layer, as
 *  `processLayer` serves them, for a suite that opens a real global root. */
export const globalValuesOver = <E, R>(
  database: Layer.Layer<GlobalDatabase, E, R>,
): Layer.Layer<GlobalValues | GlobalDatabase, E, R> =>
  Layer.provideMerge(
    Layer.effect(
      GlobalValues,
      Effect.map(GlobalDatabase, (opened) => opened.values),
    ),
    database,
  );

/**
 * A host's process ports and the workspace roots installed beside them, plus the
 * setup platform a setup-tool suite provides (absent on every other host:
 * a setup-tool call there is a test error).
 */
export interface FakeHost {
  readonly app: TestApp;
  readonly platform: FakeProcessPorts;
  readonly roots: WorkspaceRoots;
  /** The store the host's `Secrets` service reads, as a root's own local. */
  readonly secrets: PlatformSecrets;
  readonly setup?: SetupPlatformShape;
}

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
    app: options.app ?? HARNESS_APP,
    platform: createFakePlatform(options, platformOverrides),
    roots: createFakeWorkspaceRoots(options, {
      config,
      workspaceState,
      globalState,
    }),
    secrets: secrets ?? new FakeSecrets(options.secrets),
    ...(setup ? { setup } : {}),
  };
}

/**
 * The host installed now. A process is built once per block while hosts
 * change per test, so the ports below read this binding on every call.
 */
let current: FakeHost | undefined;

export function installedHost(): FakeHost {
  if (!current)
    throw new Error(
      'No fake host is installed: run the block or test over `FakeHost.layer` (support/testKernel.ts).',
    );
  return current;
}

/**
 * Installs `host` for the calling scope. Closing the scope reinstalls the
 * host it replaced (none at the start of a file), so a host never outlives
 * the block or test that installed it.
 */
export const installFakeHost = (
  host: FakeHost,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const replaced = current;
      current = host;
      return replaced;
    }),
    (replaced) =>
      Effect.sync(() => {
        current = replaced;
      }),
  );

/**
 * The `Secrets` and `AppState` services of every test process, in the shape
 * `fakeSetupPlatform` (`texraApp.ts`) uses: each member reads the installed host when
 * it is called, because the process is built once per block while hosts are
 * swapped per test. A production root passes its own store here instead: it
 * has one before it builds its process, and this harness does not.
 */
export const fakeHostSecrets: PlatformSecrets = {
  get: (key) => installedHost().secrets.get(key),
  set: (key, value) => installedHost().secrets.set(key, value),
  delete: (key) => installedHost().secrets.delete(key),
  listStoredKeys: () => installedHost().secrets.listStoredKeys(),
};

export const fakeHostAppState: StateStore = {
  get: (key) =>
    Effect.suspend(() => installedHost().roots.globalState.get(key)),
  update: (key, value) => installedHost().roots.globalState.update(key, value),
  modify: (key, change) =>
    Effect.suspend(() => installedHost().roots.globalState.modify(key, change)),
};

/** The `AgentDirectories` service of every test process, delegating per call
 *  for the same reason `fakeHostSecrets` does: hosts change per test, the
 *  process does not. */
export const fakeHostAgentDirectories: AgentDirectoriesPort = {
  custom: () => installedHost().platform.agentDirectories.custom(),
  customConfigured: () =>
    installedHost().platform.agentDirectories.customConfigured(),
  builtIn: () => installedHost().platform.agentDirectories.builtIn(),
  teamMembers: (repoState, teamId) =>
    installedHost().app.teamMembers?.(repoState, teamId) ??
    Effect.succeed(undefined),
};

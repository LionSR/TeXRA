/**
 * Standardized per-suite fake platform override.
 *
 * `vitest.config.mjs` installs a default `createFakePlatform()` (and its
 * workspace roots) before every test file (see `setupFakePlatform.ts`), so
 * most suites need nothing else. Suites that need custom options/overrides (a
 * seeded workspace, stubbed secrets, etc.) should
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
import { Effect } from 'effect';
import { afterEach, beforeEach } from 'vitest';

import type { ToolInjections } from '@agent/runtime/toolInjection';
import {
  unavailableSupabaseAuth,
  type SupabaseAuthShape,
} from '@auth/SupabaseAuth';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { ProcessServices } from '@platform/processRuntime';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  AppState,
  LifecycleHost,
  StateStore,
} from '@platform/interfaces';
import {
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  type LanguageModelPort,
} from '@platform/languageModel';
import type { Platform } from '@platform/platform';
import { globalStorageFsLayer } from '@platform/rootedFs';
import type { PlatformSecrets, Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { GlobalDatabase } from '@shared/session/database';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { GitHubSubscriptions } from '@tools/github/subscriptionBindings';
import {
  LeanLanguageServices,
  type LeanLanguageServicesShape,
} from '@tools/lean/leanLanguageServices';
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
  /** The two ports a real root hands `installProcessRuntime`, held here as
   *  its own locals because the platform object carries no copy. */
  readonly agentResume: AgentResumePort;
  readonly languageModel: LanguageModelPort;
  readonly setup?: SetupPlatformShape;
  /** The host's account plane; absent hosts answer signed-out. */
  readonly auth?: SupabaseAuthShape;
}

type HostBuilder = () => FakeHost | Promise<FakeHost>;

/**
 * The bare runtime's subscription tables. A registry is a live ownership
 * table over a polling source, so the harness serves none: a suite that
 * exercises one provides `gitHubSubscriptionsLayer` innermost, and a read
 * here is a test wiring error rather than an empty answer. Reaching for the
 * real layer instead would load the follow-up module in this setup file,
 * ahead of the suites that mock it.
 */
const unreadGitHubSubscriptions = new Proxy(
  {} as GitHubSubscriptions['Service'],
  {
    get: (target, member) => {
      if (member === 'pr' || member === 'repo' || member === 'issue') {
        throw new Error(
          `No GitHub subscriptions in this test: provide gitHubSubscriptionsLayer to read '${member}'.`,
        );
      }
      return Reflect.get(target, member);
    },
  },
);

const unavailableLeanLanguageServices: LeanLanguageServicesShape = {
  listServers: () => [],
  executeFileCommand: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  getGoalState: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  getTermGoal: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  getHoverInfo: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  fetchDiagnosticsForFile: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  navigateToFirstError: () => Effect.void,
  executeProjectCommand: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  stopSessionsForRun: () => Effect.void,
};

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
    agentResume,
    languageModel,
    setup,
    auth,
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
    agentResume: agentResume ?? { tryResumeRun: () => Effect.succeed(false) },
    languageModel: languageModel ?? UNAVAILABLE_LANGUAGE_MODEL_PORT,
    ...(setup ? { setup } : {}),
    ...(auth ? { auth } : {}),
  };
}

/**
 * The host most recently installed. The process runtime below is built once
 * per module instance while hosts are swapped per test, so the harness's own
 * process-service values resolve against this binding on every call.
 */
let current: FakeHost | undefined;

export function installedHost(): FakeHost {
  if (!current) throw new Error('No fake host is installed.');
  return current;
}

/**
 * Swap the installed host's account plane mid-test. The host's other pieces
 * stay: a describe-level `setupPlatform` override (a scoped config provider)
 * survives the swap.
 */
export function installHostAuth(auth: SupabaseAuthShape): void {
  if (!current) throw new Error('No fake host is installed.');
  current = { ...current, auth };
}

/**
 * The installed fake host's stores, as the model-option and CLI history
 * readers take them: the secret store plus the roots' three setting slots.
 * Read per call, not captured: a suite that reinstalls its host mid-test sees
 * the new one.
 */
export function hostStores(): ModelOptionStores {
  const { secrets, roots } = installedHost();
  return { ...roots, secrets };
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

/**
 * The `Secrets` and `AppState` services of every test runtime, in the shape
 * `fakeSetupPlatform` already uses: each member reads the installed host when
 * it is called, because the runtime is built once per module instance while
 * hosts are swapped per test. A production root passes its own store here
 * instead — it has one before it installs its runtime, and this harness does
 * not.
 */
export const fakeHostSecrets: PlatformSecrets = {
  get: (key) => installedHost().secrets.get(key),
  getStored: (key) => installedHost().secrets.getStored(key),
  set: (key, value) => installedHost().secrets.set(key, value),
  delete: (key) => installedHost().secrets.delete(key),
  listStoredKeys: () => installedHost().secrets.listStoredKeys(),
  getEnv: (name) => installedHost().secrets.getEnv(name),
};

export const fakeHostAppState: StateStore = {
  get: <T>(key: string, defaultValue?: T): T =>
    installedHost().roots.globalState.get<T>(key, defaultValue),
  update: (key, value) => installedHost().roots.globalState.update(key, value),
};

/**
 * The `SupabaseAuth` service of every test runtime, in the shape
 * `fakeHostSecrets` already uses: each member reads the installed host's
 * `auth` when it runs, because the runtime is built once per module instance
 * while hosts are swapped per test. A host without one answers signed-out.
 */
let defaultUnavailableAuth: SupabaseAuthShape | undefined;
function installedAuth(): SupabaseAuthShape {
  return (
    installedHost().auth ??
    (defaultUnavailableAuth ??= unavailableSupabaseAuth())
  );
}

export const fakeHostAuth: SupabaseAuthShape = {
  get client() {
    return installedAuth().client;
  },
  get coordinator() {
    return installedAuth().coordinator;
  },
  get isReady() {
    return Effect.suspend(() => installedAuth().isReady);
  },
  get accessToken() {
    return Effect.suspend(() => installedAuth().accessToken);
  },
  get user() {
    return Effect.suspend(() => installedAuth().user);
  },
  get authenticated() {
    return Effect.suspend(() => installedAuth().authenticated);
  },
  get storedSessionState() {
    return Effect.suspend(() => installedAuth().storedSessionState);
  },
  get storedAccountLabel() {
    return Effect.suspend(() => installedAuth().storedAccountLabel);
  },
  getInitError: () => installedAuth().getInitError(),
  setInitError: (error) => installedAuth().setInitError(error),
};

/**
 * The `LanguageModel` service of every test runtime, delegating per call for
 * the same reason `fakeHostSecrets` does: the runtime is built once per
 * module instance while the host's port is swapped per test.
 */
export const fakeHostLanguageModel: LanguageModelPort = {
  isAvailable: () => installedHost().languageModel.isAvailable(),
  selectModels: (selector) =>
    installedHost().languageModel.selectModels(selector),
  onDidChange: (listener) =>
    installedHost().languageModel.onDidChange(listener),
};

/** The `AgentResume` service of every test runtime, delegating per call for
 *  the same reason `fakeHostSecrets` does: hosts change per test, the
 *  runtime does not. */
export const fakeHostAgentResume: AgentResumePort = {
  tryResumeRun: (runId, recovery) =>
    Effect.suspend(() =>
      installedHost().agentResume.tryResumeRun(runId, recovery),
    ),
};

/** The `AgentDirectories` service of every test runtime, delegating per call
 *  for the same reason `fakeHostSecrets` does: hosts change per test, the
 *  runtime does not. */
export const fakeHostAgentDirectories: AgentDirectoriesPort = {
  custom: () => installedHost().platform.agentDirectories.custom(),
  builtIn: () => installedHost().platform.agentDirectories.builtIn(),
  builtInToolUse: () =>
    installedHost().platform.agentDirectories.builtInToolUse(),
};

/** The `Lifecycle` service of every test runtime, delegating per call for the
 *  same reason `fakeHostSecrets` does: hosts change per test, the runtime
 *  does not. */
export const fakeHostLifecycle: LifecycleHost = {
  onShutdown: (phase, handler) =>
    installedHost().platform.lifecycle.onShutdown(phase, handler),
  get runShutdown() {
    return installedHost().platform.lifecycle.runShutdown;
  },
  get shutdownRan() {
    return installedHost().platform.lifecycle.shutdownRan;
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
    { initTestWorkspaceRoots },
    { setDebugModeConfig },
    { initTestProcessRuntime, tryTestProcessRuntime },
    { Layer, ManagedRuntime },
    { testHttpClientLayer },
    { Secrets },
    { AgentDirectories, AgentResume, AppState, Lifecycle },
    { LanguageModel },
    { SetupPlatform },
    { ToolInjections },
    { SupabaseAuth },
  ] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/testWorkspaceRoots'),
    import('@logger/logUtils'),
    import('./testProcessRuntime'),
    import('effect'),
    import('@test/support/fetchTestUtils'),
    import('@platform/secrets'),
    import('@platform/interfaces'),
    import('@platform/languageModel'),
    import('@tools/setup/platform'),
    import('@agent/runtime/toolInjection'),
    import('@auth/SupabaseAuth'),
  ]);
  current = host;
  // The process services, over whichever host is installed when a member is
  // called: hosts change per test, the runtime does not. These imports
  // stay eager: the process runtime is built synchronously by
  // `testRuntime().runSync` callers, so a lazily imported (asynchronous)
  // layer here fails every one of them.
  processServices ??= Layer.mergeAll(
    testHttpClientLayer,
    // The same standard-library filesystem and path services the process
    // roots provide, over the real temp roots the harness runs on.
    NodeFileSystem.layer,
    NodePath.layer,
    Layer.mock(UpdateCheckRecords, {}),
    // The records above are mocked, so the bare runtime's global-root handle
    // is too: a suite that reads it provides its own innermost.
    Layer.mock(GlobalDatabase, {}),
    Layer.mock(InquiryRecords, {}),
    // A suite that exercises a Lean tool provides its own port innermost.
    // The run-end stop is absent, as on a host whose Lean integration owns
    // server lifetime: the mock's placeholder for it would die on every run.
    Layer.mock(LeanLanguageServices, unavailableLeanLanguageServices),
    Layer.succeed(GitHubSubscriptions)(unreadGitHubSubscriptions),
    Secrets.layer(fakeHostSecrets),
    AppState.layer(fakeHostAppState),
    SupabaseAuth.layer(fakeHostAuth),
    LanguageModel.layer(fakeHostLanguageModel),
    AgentResume.layer(fakeHostAgentResume),
    AgentDirectories.layer(fakeHostAgentDirectories),
    Lifecycle.layer(fakeHostLifecycle),
    SetupPlatform.layer(fakeSetupPlatform),
    // No conditional injections on the bare fake host: a suite that
    // exercises them passes its own list to `resolveAgentTools`.
    ToolInjections.layer([]),
    // The cross-workspace storage view the process runtime serves, over the
    // installed host's global root. A suite that exercises it directly
    // provides its own view innermost.
    Layer.provide(
      globalStorageFsLayer(current?.roots.globalStorage ?? ''),
      Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
    ),
  );
  initPlatform(host.platform);
  initTestWorkspaceRoots(host.roots);
  // The logger's process-wide debug-mode read, over this fake host's
  // configuration, as a composition root installs it.
  setDebugModeConfig(host.roots.config);
  // A bare process runtime for the Promise-facing boundaries that run
  // fibers (the loopback sign-in). The session graph family is not installed
  // here: `sessionGraphTestSetup` loads the graph's production modules, and
  // a suite imports it (through `sessionTestUtils` or
  // `defaultSessionTestSetup`) after its own `vi.mock` registrations, which
  // this install, called from a setup file or a `beforeEach`, cannot promise.
  if (tryTestProcessRuntime() == null) {
    initTestProcessRuntime(ManagedRuntime.make(processServices));
  }
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
 * when the host must be computed per test (a
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

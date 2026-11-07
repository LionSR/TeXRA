/**
 * The fake host a suite runs over: the record (`createFakeHost`) a block or
 * a test builds with `FakeHost.layer` (`testKernel.ts`), which serves it and
 * points the block's process at it while the layer lives.
 */
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

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
  makeHostRoot,
  type TestApp,
  type FakeHostOverrides,
  type FakeProcessPorts,
  type FakePlatformOptions,
} from './FakePlatform';

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
  /** The host's own real directory, removed with its `FakeHost.layer`. */
  readonly root: string;
  /** A real path inside {@link root}: `path('workspace/a.tex')` is where a
   *  `files` seed keyed `'/workspace/a.tex'` is written. */
  readonly path: (...segments: string[]) => string;
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
  const root = makeHostRoot();
  return {
    root,
    path: (...segments) => join(root, ...segments),
    app: options.app ?? HARNESS_APP,
    platform: createFakePlatform(root, options, platformOverrides),
    roots: createFakeWorkspaceRoots(
      options,
      { config, workspaceState, globalState },
      root,
    ),
    secrets: secrets ?? new FakeSecrets(options.secrets),
    ...(setup ? { setup } : {}),
  };
}

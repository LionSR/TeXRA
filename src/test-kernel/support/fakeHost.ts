/**
 * The fake host a suite runs over: the record (`createFakeHost`) a block or
 * a test builds with `FakeHost.layer` (`testKernel.ts`), which serves it and
 * points the block's process at it while the layer lives. A suite whose
 * imports reach this module runs in the `kernel` tier (`vitest.config.mjs`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { Effect, Scope } from 'effect';

import type { AgentDirectoriesPort } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  createFakeWorkspaceRoots,
  FakeSecrets,
  HARNESS_APP,
  makeHostRoot,
  type TestApp,
  type FakeHostOverrides,
  type FakeProcessPorts,
  type FakePlatformOptions,
} from './FakePlatform';

/** A host's process ports and the workspace roots installed beside them. */
export interface HostRecord {
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
}

/**
 * The real file a seed key names inside `root`. A key is a path inside the
 * root: `'/workspace/a.tex'` and `host.path('workspace/a.tex')` name the same
 * file, the first the spelling a suite writes by hand, the second one a path
 * helper built on the host produces. A key that resolves outside the root
 * throws.
 */
function seedTarget(root: string, key: string): string {
  const target = key.startsWith(root)
    ? path.resolve(key)
    : path.resolve(root, `.${path.sep}${key}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Seed key ${key} resolves outside the fake root; seed keys must stay inside it.`,
    );
  }
  return target;
}

/** Writes the seeded files into `root`. */
function seedRoot(
  root: string,
  files: Record<string, string | Uint8Array>,
): void {
  for (const [key, content] of Object.entries(files)) {
    const file = seedTarget(root, key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

const fakeAgentDirectories = (
  root: string,
  { teamMembers }: TestApp,
): AgentDirectoriesPort => ({
  custom: () => Effect.succeed(path.join(root, 'workspace/.texra/agents')),
  customConfigured: () => Effect.succeed(false),
  builtIn: () => Effect.succeed(path.join(root, 'workspace/resources/agents')),
  ...(teamMembers ? { teamMembers } : {}),
});

/** A host's process ports over `root`, with `options.files` seeded into it. */
function createFakePlatform(
  root: string,
  options: FakePlatformOptions = {},
  overrides: Partial<FakeProcessPorts> = {},
): FakeProcessPorts {
  seedRoot(root, options.files ?? {});
  return {
    shutdownScope: Scope.makeUnsafe(),
    agentDirectories: fakeAgentDirectories(root, options.app ?? HARNESS_APP),
    ...overrides,
  };
}

/** Build both halves of a fake host from one option bag. */
export function createFakeHost(
  options: FakePlatformOptions = {},
  overrides: FakeHostOverrides = {},
): HostRecord {
  const { config, workspaceState, globalState, secrets, ...platformOverrides } =
    overrides;
  const root = makeHostRoot();
  return {
    root,
    path: (...segments) => path.join(root, ...segments),
    app: options.app ?? HARNESS_APP,
    platform: createFakePlatform(root, options, platformOverrides),
    roots: createFakeWorkspaceRoots(
      options,
      { config, workspaceState, globalState },
      root,
    ),
    secrets: secrets ?? new FakeSecrets(options.secrets),
  };
}

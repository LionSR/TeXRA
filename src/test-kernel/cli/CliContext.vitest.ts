import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { Effect } from 'effect';
import {
  buildCliContext,
  type BuildCliContextInit,
  type CliContext,
} from '@cli/runtime/cliContext';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { withEnv } from '@test/support/testEnv';

const ambient = {
  isCi: true,
  stdinIsTty: false,
  stdoutIsTty: false,
  stderrIsTty: false,
  stdoutColorEnabled: false,
  stderrColorEnabled: false,
};

const tempDirs = useTempDirs();

/**
 * Every `buildCliContext` call here gets an empty user-level storage root: the
 * developer's own `~/.texra/v1/global-storage/config.json` must never decide an
 * assertion. Tests that exercise the user layer pass their own `storageRoot`.
 */
async function cliContext(init: BuildCliContextInit): Promise<CliContext> {
  return Effect.runPromise(
    buildCliContext({
      storageRoot: await makeTempDir('texra-cli-storage-', tempDirs),
      ...init,
    }).pipe(withEnv({}), Effect.provide(nodePlatformLayer)),
  );
}

async function workspaceWithConfig(config: string): Promise<string> {
  const workspace = await makeTempDir('texra-cli-context-', tempDirs);
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(join(workspace, '.texra', 'config.json'), config);
  return workspace;
}

describe('CLI context config defaults', () => {
  it('reads the approval policy from the user files, never the project file', async () => {
    const storageRoot = await makeTempDir('texra-cli-user-config-', tempDirs);
    const globalStorage = resolveGlobalStoragePath(storageRoot);
    await mkdir(globalStorage, { recursive: true });
    await writeFile(
      join(globalStorage, 'config.json'),
      JSON.stringify({ 'texra.approvalPolicy': 'yolo' }),
    );

    // A project file (which a cloned repository can supply) cannot loosen or
    // tighten the policy, and the ignored key is reported; a telemetry opt-out
    // there is honoured, so it is not...
    const workspace = await workspaceWithConfig(
      JSON.stringify({
        'texra.approvalPolicy': 'never',
        'texra.telemetry.enabled': false,
      }),
    );
    const projectContext = await cliContext({
      ambient,
      globalArgs: { cwd: workspace },
      storageRoot,
    });
    expect(projectContext.approvalPolicy).toBe('yolo');
    expect(projectContext.configDegradations.join('\n')).toContain(
      'Ignoring "texra.approvalPolicy"',
    );
    expect(projectContext.configDegradations.join('\n')).not.toContain(
      'texra.telemetry.enabled',
    );

    // ...while the user's own file for that workspace does win over the
    // user-wide one.
    const localDir = resolveWorkspaceStoragePath(
      storageRoot,
      projectContext.cwd,
    );
    await mkdir(localDir, { recursive: true });
    await writeFile(
      join(localDir, 'config.json'),
      JSON.stringify({ 'texra.approvalPolicy': 'never' }),
    );
    await expect(
      cliContext({
        ambient,
        globalArgs: { cwd: workspace },
        storageRoot,
      }),
    ).resolves.toMatchObject({ approvalPolicy: 'never' });

    // The user-wide file decides elsewhere, as it does for the extension and
    // desktop hosts through `testWorkspaceRoots().config`.
    await expect(
      cliContext({
        ambient,
        globalArgs: { cwd: tmpdir() },
        storageRoot,
      }),
    ).resolves.toMatchObject({ approvalPolicy: 'yolo' });
  });
});

describe('CLI color/no-input flag wiring', () => {
  it('--no-input forces headless mode and defaults approval policy to never', async () => {
    const context = await cliContext({
      // stdin is a TTY, so without --no-input this would be interactive.
      ambient: {
        isCi: false,
        stdinIsTty: true,
        stdoutIsTty: true,
        stderrIsTty: true,
        stdoutColorEnabled: true,
        stderrColorEnabled: true,
      },
      globalArgs: { cwd: tmpdir(), noInput: true },
    });
    expect(context.mode).toBe('headless');
    expect(context.approvalPolicy).toBe('never');
  });
});

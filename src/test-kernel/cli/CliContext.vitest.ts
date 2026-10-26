import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { describe, expect, vi } from 'vitest';

import { Effect } from 'effect';
import {
  buildCliContext,
  CliUsageError,
  resolveStreamColor,
  type BuildCliContextInit,
  type CliAmbientState,
  type CliContext,
} from '@cli/runtime/cliContext';
import * as logSinks from '@cli/runtime/logSinks';
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

function ttyAmbient(overrides: Partial<CliAmbientState> = {}): CliAmbientState {
  return {
    isCi: false,
    stdinIsTty: true,
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    ...overrides,
  };
}

const tempDirs = useTempDirs();

/**
 * Every `buildCliContext` call here gets an empty user-level storage root: the
 * developer's own `~/.texra/v1/global-storage/config.json` must never decide an
 * assertion. Tests that exercise the user layer pass their own `storageRoot`.
 */
async function cliContext({
  env,
  ...init
}: BuildCliContextInit & {
  readonly env?: Record<string, string>;
}): Promise<CliContext> {
  return Effect.runPromise(
    buildCliContext({
      storageRoot: await makeTempDir('texra-cli-storage-', tempDirs),
      ...init,
    }).pipe(withEnv(env ?? {}), Effect.provide(nodePlatformLayer)),
  );
}

async function workspaceWithConfig(config: string): Promise<string> {
  const workspace = await makeTempDir('texra-cli-context-', tempDirs);
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(join(workspace, '.texra', 'config.json'), config);
  return workspace;
}

describe('CLI context config defaults', () => {
  it('applies flag over env over workspace config over built-in defaults', async () => {
    const workspace = await workspaceWithConfig(
      JSON.stringify({
        outputFormat: 'json',
        approvalPolicy: 'ask',
      }),
    );

    await expect(
      cliContext({
        ambient,
        env: { TEXRA_OUTPUT_FORMAT: 'ndjson' },
        globalArgs: { cwd: workspace },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'ndjson',
      approvalPolicy: 'ask',
    });

    await expect(
      cliContext({
        ambient,
        env: { TEXRA_OUTPUT_FORMAT: 'ndjson' },
        globalArgs: { cwd: workspace, outputFormat: 'text' },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'text',
      approvalPolicy: 'ask',
    });

    await expect(
      cliContext({
        ambient,
        env: {},
        globalArgs: { cwd: tmpdir() },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'text',
      approvalPolicy: 'ask',
    });
  });

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
      env: {},
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
        env: {},
        globalArgs: { cwd: workspace },
        storageRoot,
      }),
    ).resolves.toMatchObject({ approvalPolicy: 'never' });

    // The user-wide file decides elsewhere, as it does for the extension and
    // desktop hosts through `testWorkspaceRoots().config`.
    await expect(
      cliContext({
        ambient,
        env: {},
        globalArgs: { cwd: tmpdir() },
        storageRoot,
      }),
    ).resolves.toMatchObject({ approvalPolicy: 'yolo' });
  });

  it.each([
    { label: 'malformed JSON', write: () => workspaceWithConfig('{') },
    {
      label: 'an unreadable path',
      write: async () => {
        const workspace = await makeTempDir('texra-cli-context-', tempDirs);
        await mkdir(join(workspace, '.texra', 'config.json'), {
          recursive: true,
        });
        return workspace;
      },
    },
  ])(
    'says so out loud and keeps running when the project config has $label',
    async ({ write }) => {
      const warnSpy = vi
        .spyOn(logSinks, 'writeTextStderr')
        .mockImplementation(() => {});
      try {
        const workspace = await write();

        const context = await cliContext({
          ambient,
          env: {},
          globalArgs: { cwd: workspace },
        });

        // The unreadable file is ignored, loudly, never fatal; the degradation
        // is one `contextFromArgs` prints even under `--quiet`.
        expect(context.approvalPolicy).toBe('ask');
        expect(context.configDegradations).toEqual([
          expect.stringContaining(join('.texra', 'config.json')),
        ]);
        expect(context.configWarnings).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );
});

describe('CLI --cwd validation', () => {
  // `it.live`, not `it.effect`: these probe the real filesystem, so a
  // TestContext clock starting at 0 would be a trap rather than a help.
  const cwdFailure = (cwd: string) =>
    Effect.promise(() =>
      cliContext({ ambient, env: {}, globalArgs: { cwd } }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );

  it.live('rejects a --cwd path that does not exist', () =>
    Effect.gen(function* () {
      const missing = join(tmpdir(), 'texra-cli-cwd-missing-' + Date.now());

      const failure = yield* cwdFailure(missing);
      expect(failure).toBeInstanceOf(CliUsageError);
      expect((failure as CliUsageError).message).toMatch(/does not exist/);
    }),
  );
});

describe('CLI per-stream color resolution', () => {
  it.each([
    {
      label: 'NO_COLOR disables color even on a TTY',
      isTty: true,
      options: { env: { NO_COLOR: '1' } },
      expected: false,
    },
    {
      label: 'empty NO_COLOR still disables color',
      isTty: true,
      options: { env: { NO_COLOR: '' } },
      expected: false,
    },
    {
      label: 'TERM=dumb disables color even on a TTY',
      isTty: true,
      options: { env: { TERM: 'dumb' } },
      expected: false,
    },
    {
      label: 'FORCE_COLOR enables color even off a TTY',
      isTty: false,
      options: { env: { FORCE_COLOR: '1' } },
      expected: true,
    },
    {
      label: 'FORCE_COLOR=0 disables color even on a TTY',
      isTty: true,
      options: { env: { FORCE_COLOR: '0' } },
      expected: false,
    },
    {
      label: 'FORCE_COLOR=no disables color even on a TTY',
      isTty: true,
      options: { env: { FORCE_COLOR: 'no' } },
      expected: false,
    },
    {
      label: 'empty FORCE_COLOR does not force color off a TTY',
      isTty: false,
      options: { env: { FORCE_COLOR: '' } },
      expected: false,
    },
    {
      label: 'NO_COLOR wins over FORCE_COLOR',
      isTty: true,
      options: { env: { FORCE_COLOR: '1', NO_COLOR: '1' } },
      expected: false,
    },
  ])('$label', ({ isTty, options, expected }) => {
    expect(resolveStreamColor(isTty, options)).toBe(expected);
  });
});

describe('CLI color/no-input flag wiring', () => {
  it('--no-input forces headless mode and defaults approval policy to never', async () => {
    const context = await cliContext({
      // stdin is a TTY, so without --no-input this would be interactive.
      ambient: ttyAmbient(),
      env: {},
      globalArgs: { cwd: tmpdir(), noInput: true },
    });
    expect(context.mode).toBe('headless');
    expect(context.approvalPolicy).toBe('never');
  });

  it('--no-input preserves explicit approval policy', async () => {
    const context = await cliContext({
      ambient: ttyAmbient(),
      env: {},
      globalArgs: { cwd: tmpdir(), noInput: true, approvalPolicy: 'yolo' },
    });
    expect(context.mode).toBe('headless');
    expect(context.approvalPolicy).toBe('yolo');
  });
});

/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// The shared mock registrations evaluate before `@cli/commands/root` below.
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';

const mocks = vi.hoisted(() => ({
  getCliModelAccessList: vi.fn(),
}));

vi.mock('@cli/runtime/modelAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/modelAccess')>();
  return {
    ...actual,
    getCliModelAccessList: mocks.getCliModelAccessList,
  };
});

import { runCli } from '@cli/commands/root';
import type { CliModelAccess } from '@cli/runtime/modelAccess';
import { testRuntime } from '@test/support/testProcessRuntime';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { REPO_ROOT } from '@test/support/repoScan';
import { installedHost, setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

function modelAccess(
  value: string,
  {
    label = value,
    ...overrides
  }: { label?: string } & Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: { value, label },
    available: true,
    status: 'available',
    ...overrides,
  };
}

const tempDirs = useTempDirs();

// The init command picks its default agent from the real catalog: the
// installed host's agent directories are the bundled resources, with an empty
// custom dir standing in for a workspace without custom agents.
let customAgentsDir: string;

/** The real agent directories the installed host serves. */
const bundledAgentDirectories = () => ({
  custom: () => Effect.succeed(customAgentsDir),
  customConfigured: () => Effect.succeed(false),
  builtIn: () =>
    Effect.succeed(path.join(REPO_ROOT, 'packages/extension/resources/agents')),
});

beforeAll(async () => {
  customAgentsDir = await makeTempDir('texra-init-agents-', tempDirs);
});

setupPlatform(
  {},
  {
    agentDirectories: bundledAgentDirectories(),
  },
);

// The catalog is loaded over the installed host's agent directories before
// each command runs, as the process runtime does at build, so the one real
// scan's info line lands before the output spies.
beforeEach(async () => {
  const { AgentCatalog } = await import('@agent/index/agentCatalog');
  await testRuntime().runPromise(
    AgentCatalog.use((catalog) => catalog.refresh),
  );
});

describe('CLI init command', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    stdout = '';
    stderr = '';
    mocks.getCliModelAccessList
      .mockReset()
      .mockReturnValue(
        Effect.succeed([modelAccess('deepseek/deepseek-v4-pro')]),
      );
    // The command threads the stores this call hands back into the model
    // access list and the workspace agents' visibility read, so the mock returns the
    // installed host's own stores.
    const host = installedHost();
    cliInitPlatformMock.initCliPlatform.mockReset().mockReturnValue(
      Effect.succeed({
        secrets: host.secrets,
        globalState: host.roots.globalState,
        workspaceState: host.roots.workspaceState,
        repoState: host.roots.repoState,
        runtime: testRuntime(),
      }),
    );
    cliInitPlatformMock.installCliProcessRuntime
      .mockReset()
      .mockImplementation(() => testRuntime());
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function runInitPrint(
    root: string,
    extraArgs: string[] = [],
  ): ReturnType<typeof runCli> {
    return runCli([
      '--cwd',
      root,
      'init',
      '--print',
      ...extraArgs,
      '--gitignore',
      '--no-color',
    ]);
  }

  it('emits valid NDJSON for non-interactive init', async () => {
    const root = await makeTempDir('texra-init-test-', tempDirs);
    const result = await runInitPrint(root, ['--output-format', 'ndjson']);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).not.toContain('Wrote ');
    expect(stdout).not.toContain('Created .gitignore');
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as {
      readonly kind?: string;
      readonly ts?: string;
      readonly init?: {
        readonly path?: string;
        readonly agent?: string;
        readonly model?: string;
        readonly outputFormat?: string;
        readonly gitignore?: string;
        readonly config?: unknown;
      };
    };
    expect(record).toMatchObject({
      kind: 'init-config',
      init: {
        path: path.join(root, '.texra', 'config.json'),
        agent: 'assistant',
        model: 'deepseek/deepseek-v4-pro',
        outputFormat: 'text',
        gitignore: 'created',
        config: {
          'texra.model': 'deepseek/deepseek-v4-pro',
          'texra.outputFormat': 'text',
          'texra.chat': {
            agent: 'assistant',
            model: 'deepseek/deepseek-v4-pro',
          },
        },
      },
    });
    expect(record.ts).toEqual(expect.any(String));
    await expect(
      fs.readFile(path.join(root, '.gitignore'), 'utf8'),
    ).resolves.toBe('.texra/\n');
  });
});

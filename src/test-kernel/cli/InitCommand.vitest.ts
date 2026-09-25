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

const mocks = vi.hoisted(() => ({
  getCliModelAccessList: vi.fn(),
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', async () => {
  const { Effect } = await import('effect');
  return {
    installCliProcessRuntime: mocks.installCliProcessRuntime,
    disposeCliProcessRuntime: Effect.void,
  };
});

vi.mock('@cli/runtime/modelAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/modelAccess')>();
  return {
    ...actual,
    getCliModelAccessList: mocks.getCliModelAccessList,
  };
});

import { runCli } from '@cli/commands/root';
import { initWizardModelSelectItems } from '@cli/init/runInitWizard';
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

function expectUnavailableDefaultRecovery(output: string): void {
  expect(output).toContain('Note: "deepseekproT" is not currently usable.');
  expect(output).toContain('Next: Add a provider API key with `texra setup`.');
  expect(output).toContain('Run `texra models list --all` to inspect access.');
  expect(output).toContain(
    'After a model is available, run `texra` to start a chat.',
  );
  expect(output).not.toContain('Next: run `texra` to start a chat.');
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
  builtInToolUse: () =>
    Effect.succeed(
      path.join(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    ),
});

beforeAll(async () => {
  customAgentsDir = await makeTempDir('texra-init-agents-', tempDirs);
  // Preload the catalog cache (module-level) so the command's own
  // `loadAgents({ includeRemote: false })` is a silent cache hit: the one
  // real scan logs an info line that the output-shape tests would otherwise
  // read as stderr noise.
  const { refresh } = await import('@agent/index/agentRegistry');
  const { AgentDirectories } = await import('@platform/interfaces');
  await testRuntime().runPromise(
    refresh({ includeRemote: false }).pipe(
      Effect.provideService(AgentDirectories, bundledAgentDirectories()),
    ),
  );
});

setupPlatform(
  {},
  {
    agentDirectories: bundledAgentDirectories(),
  },
);

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
      .mockReturnValue(Effect.succeed([modelAccess('deepseekproT')]));
    // The command threads the stores this call hands back into the model
    // access list and the roster's visibility read, so the mock returns the
    // installed host's own stores.
    const host = installedHost();
    mocks.initCliPlatform.mockReset().mockReturnValue(
      Effect.succeed({
        secrets: host.secrets,
        globalState: host.roots.globalState,
        workspaceState: host.roots.workspaceState,
        runtime: testRuntime(),
      }),
    );
    mocks.installCliProcessRuntime
      .mockReset()
      .mockImplementation(async () => testRuntime());
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

  it.each([
    {
      name: 'disables init model rows without a usable credential',
      models: [
        modelAccess('sonnet46T', {
          label: 'Sonnet',
          available: true,
          status: 'subscription',
        }),
        modelAccess('deepseekT', {
          label: 'DeepSeek',
          available: false,
          status: 'api key set',
        }),
      ],
      expected: [
        {
          value: 'sonnet46T',
          label: 'Sonnet',
          description: 'subscription',
          disabled: false,
        },
        {
          value: 'deepseekT',
          label: 'DeepSeek',
          description: 'api key set (unavailable now)',
          disabled: true,
        },
      ],
    },
    {
      name: 'keeps all-unavailable init model rows selectable as a fallback',
      models: [
        modelAccess('sonnet46T', {
          label: 'Sonnet',
          available: false,
          status: 'login required',
        }),
        modelAccess('deepseekT', {
          label: 'DeepSeek',
          available: false,
          status: 'missing key',
        }),
      ],
      expected: [
        {
          value: 'sonnet46T',
          label: 'Sonnet',
          description: 'login required (unavailable now)',
          disabled: false,
        },
        {
          value: 'deepseekT',
          label: 'DeepSeek',
          description: 'missing key (unavailable now)',
          disabled: false,
        },
      ],
    },
  ])('$name', ({ models, expected }) => {
    expect(initWizardModelSelectItems(models)).toEqual(expected);
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
        readonly approvalPolicy?: string;
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
        model: 'deepseekproT',
        approvalPolicy: 'ask',
        outputFormat: 'text',
        gitignore: 'created',
        config: {
          'texra.model': 'deepseekproT',
          'texra.outputFormat': 'text',
          'texra.approvalPolicy': 'ask',
          'texra.chat': { agent: 'assistant', model: 'deepseekproT' },
        },
      },
    });
    expect(record.ts).toEqual(expect.any(String));
    await expect(
      fs.readFile(path.join(root, '.gitignore'), 'utf8'),
    ).resolves.toBe('.texra/\n');
  });

  it.each([
    {
      name: 'points non-interactive init at model recovery when the default model is unavailable',
      accessList: [
        modelAccess('deepseekproT', {
          available: false,
          status: 'missing key',
          model: {
            value: 'deepseekproT',
            label: 'DeepSeek Pro',
            availability: 'missing-key',
          },
        }),
      ],
    },
    {
      name: 'points init at model recovery when the fallback default has no access entry',
      accessList: [
        modelAccess('sonnet46T', {
          available: false,
          status: 'missing api key',
          model: {
            value: 'sonnet46T',
            label: 'Sonnet',
            availability: 'missing-key',
          },
        }),
      ],
    },
  ])('$name', async ({ accessList }) => {
    mocks.getCliModelAccessList.mockReturnValue(Effect.succeed(accessList));
    const root = await makeTempDir('texra-init-test-', tempDirs);
    const result = await runInitPrint(root);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expectUnavailableDefaultRecovery(stdout);
  });
});

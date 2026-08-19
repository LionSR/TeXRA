import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCliModelAccessList: vi.fn(),
  getVisibleAgents: vi.fn(),
  initCliPlatform: vi.fn(),
  loadAgents: vi.fn(),
}));

vi.mock('@agent/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/index')>();
  return {
    ...actual,
    getVisibleAgents: mocks.getVisibleAgents,
    loadAgents: mocks.loadAgents,
  };
});

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
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
import {
  defaultInitAgentOptions,
  defaultInitAnswers,
  initCommand,
} from '@cli/commands/init';
import {
  initWizardDefaultAgentIndex,
  initWizardModelSelectItems,
} from '@cli/init/runInitWizard';
import type { CliModelAccess } from '@cli/runtime/modelAccess';
import { AgentCategory } from '@shared/schemas';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

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
    'After a model is available, run `texra` for the launcher or `texra chat` to start.',
  );
  expect(output).not.toContain(
    'Next: run `texra` for the launcher, or `texra chat` to start.',
  );
}

const tempDirs: string[] = [];

describe('CLI init command', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    mocks.getCliModelAccessList
      .mockReset()
      .mockResolvedValue([modelAccess('deepseekproT')]);
    mocks.getVisibleAgents
      .mockReset()
      .mockReturnValue([
        { name: 'assistant', category: AgentCategory.ToolUse },
      ]);
    mocks.initCliPlatform.mockReset().mockResolvedValue(undefined);
    mocks.loadAgents.mockReset().mockResolvedValue(undefined);
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    await cleanupTempDirs(tempDirs);
  });

  it('accepts global CLI flags while keeping init-specific cwd help', () => {
    const args = initCommand.args as Record<
      string,
      {
        readonly type?: string;
        readonly valueHint?: string;
        readonly description?: string;
      }
    >;

    expect(args).toHaveProperty('approval-policy');
    expect(args).toHaveProperty('color');
    expect(args).toHaveProperty('no-input');
    expect(args.cwd).toMatchObject({
      type: 'string',
      valueHint: 'directory',
      description: 'Working directory to initialize (defaults to $PWD)',
    });
  });

  it('does not offer simplifier as a default init agent option', () => {
    const registryAgents: Array<{ name: string; description: string }> = [
      { name: 'chat', description: 'General chat' },
      { name: 'simplifier', description: 'Code simplification' },
      { name: 'review', description: 'Code review' },
    ];
    const options = defaultInitAgentOptions(registryAgents);

    expect(options).toEqual([{ name: 'chat' }, { name: 'review' }]);
  });

  it('defaults non-interactive init to the visible team lead', () => {
    const answers = defaultInitAnswers(
      [{ name: 'research' }, { name: 'review' }],
      [modelAccess('sonnet46T')],
    );

    expect(answers.agent).toBe('research');
    expect(answers.model).toBe('sonnet46T');
  });

  it('highlights the visible team lead in the interactive init wizard', () => {
    expect(
      initWizardDefaultAgentIndex([
        { name: 'research' },
        { name: 'review' },
        { name: 'assistant' },
      ]),
    ).toBe(2);

    expect(
      initWizardDefaultAgentIndex([{ name: 'research' }, { name: 'review' }]),
    ).toBe(0);
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
    const workspaceRoot = await fs.realpath(root);
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
        path: path.join(workspaceRoot, '.texra', 'config.json'),
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

  it('keeps the legacy text init summary for human output', async () => {
    const root = await makeTempDir('texra-init-test-', tempDirs);
    const workspaceRoot = await fs.realpath(root);
    const result = await runInitPrint(root);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Created .gitignore (.texra/ ignored).');
    expect(stdout).toContain(
      `Wrote ${path.join(workspaceRoot, '.texra', 'config.json')}`,
    );
    expect(stdout).toContain('  agent: assistant');
    expect(stdout).toContain('Next: run `texra` for the launcher');
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
            requiresKey: true,
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
            disabled: true,
            requiresKey: true,
          },
        }),
      ],
    },
  ])('$name', async ({ accessList }) => {
    mocks.getCliModelAccessList.mockResolvedValue(accessList);
    const root = await makeTempDir('texra-init-test-', tempDirs);
    const result = await runInitPrint(root);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expectUnavailableDefaultRecovery(stdout);
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
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

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
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

function modelAccess(
  value: string,
  overrides: Partial<CliModelAccess> = {},
): CliModelAccess {
  return {
    model: { value, label: value },
    available: true,
    status: 'available',
    ...overrides,
  };
}

async function withTempProject<T>(
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-init-test-'));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function expectUnavailableDefaultRecovery(output: string): void {
  expect(output).toContain(
    'Note: "deepseekproT" is not usable in the current access mode.',
  );
  expect(output).toContain(
    'Next: Add a provider API key with `texra setup` for personal mode',
  );
  expect(output).toContain('Run `texra models list --all` to inspect access.');
  expect(output).toContain(
    'After a model is available, run `texra` for the launcher or `texra chat` to start.',
  );
  expect(output).not.toContain(
    'Next: run `texra` for the launcher, or `texra chat` to start.',
  );
}

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
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        stdout += String(chunk);
        const cb = rest.find((arg) => typeof arg === 'function') as
          ((err?: Error | null) => void) | undefined;
        cb?.(null);
        return true;
      }) as unknown as ReturnType<typeof vi.spyOn>;
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        stderr += String(chunk);
        const cb = rest.find((arg) => typeof arg === 'function') as
          ((err?: Error | null) => void) | undefined;
        cb?.(null);
        return true;
      }) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
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

    expect(args).toHaveProperty('api-mode');
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

  it('disables init model rows unavailable in the active API mode', () => {
    expect(
      initWizardModelSelectItems([
        modelAccess('sonnet46T', {
          model: { value: 'sonnet46T', label: 'Sonnet' },
          available: true,
          status: 'included access',
        }),
        modelAccess('deepseekT', {
          model: { value: 'deepseekT', label: 'DeepSeek' },
          available: false,
          status: 'api key set',
        }),
      ]),
    ).toEqual([
      {
        value: 'sonnet46T',
        label: 'Sonnet',
        description: 'included access',
        disabled: false,
      },
      {
        value: 'deepseekT',
        label: 'DeepSeek',
        description: 'api key set (unavailable now)',
        disabled: true,
      },
    ]);
  });

  it('keeps all-unavailable init model rows selectable as a fallback', () => {
    expect(
      initWizardModelSelectItems([
        modelAccess('sonnet46T', {
          model: { value: 'sonnet46T', label: 'Sonnet' },
          available: false,
          status: 'login required',
        }),
        modelAccess('deepseekT', {
          model: { value: 'deepseekT', label: 'DeepSeek' },
          available: false,
          status: 'missing key',
        }),
      ]),
    ).toEqual([
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
    ]);
  });

  it('emits valid NDJSON for non-interactive init', async () => {
    await withTempProject(async (root) => {
      const workspaceRoot = await fs.realpath(root);
      const result = await runCli([
        '--cwd',
        root,
        'init',
        '--print',
        '--api-mode',
        'personal',
        '--output-format',
        'ndjson',
        '--gitignore',
        '--no-color',
      ]);

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
            model: 'deepseekproT',
            outputFormat: 'text',
            approvalPolicy: 'ask',
            chat: { agent: 'assistant', model: 'deepseekproT' },
          },
        },
      });
      expect(record.ts).toEqual(expect.any(String));
      await expect(
        fs.readFile(path.join(root, '.gitignore'), 'utf8'),
      ).resolves.toBe('.texra/\n');
    });
  });

  it('keeps the legacy text init summary for human output', async () => {
    await withTempProject(async (root) => {
      const workspaceRoot = await fs.realpath(root);
      const result = await runCli([
        '--cwd',
        root,
        'init',
        '--print',
        '--api-mode',
        'personal',
        '--gitignore',
        '--no-color',
      ]);

      expect(result.exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Created .gitignore (.texra/ ignored).');
      expect(stdout).toContain(
        `Wrote ${path.join(workspaceRoot, '.texra', 'config.json')}`,
      );
      expect(stdout).toContain('  agent: assistant');
      expect(stdout).toContain('Next: run `texra` for the launcher');
    });
  });

  it('points non-interactive init at model recovery when the default model is unavailable', async () => {
    mocks.getCliModelAccessList.mockResolvedValue([
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
    ]);
    await withTempProject(async (root) => {
      const result = await runCli([
        '--cwd',
        root,
        'init',
        '--print',
        '--api-mode',
        'personal',
        '--gitignore',
        '--no-color',
      ]);

      expect(result.exitCode).toBe(0);
      expect(stderr).toBe('');
      expectUnavailableDefaultRecovery(stdout);
    });
  });

  it('points init at model recovery when the fallback default has no access entry', async () => {
    mocks.getCliModelAccessList.mockResolvedValue([
      modelAccess('sonnet46T', {
        available: false,
        status: 'login required',
        model: {
          value: 'sonnet46T',
          label: 'Sonnet',
          availability: 'included-login-required',
          disabled: true,
        },
      }),
    ]);
    await withTempProject(async (root) => {
      const result = await runCli([
        '--cwd',
        root,
        'init',
        '--print',
        '--api-mode',
        'personal',
        '--gitignore',
        '--no-color',
      ]);

      expect(result.exitCode).toBe(0);
      expect(stderr).toBe('');
      expectUnavailableDefaultRecovery(stdout);
    });
  });
});

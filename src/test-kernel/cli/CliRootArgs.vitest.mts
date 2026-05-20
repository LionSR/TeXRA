import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { END_GROUP_STATUS, EXECUTION_STATUS } from '@shared/schemas';

import {
  cliTerminalStatus,
  collectStringFlagValues,
  doctorPlatformInitContext,
  expandWorkflowInputSpecs,
  formatCliModelListError,
  isCliFetchStackLog,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  resolveLoginProvider,
  resolveWorkflowOutput,
} from '../../../packages/cli/src/commands/root';
import type { CliContext } from '../../../packages/cli/src/runtime/cliContext';

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'headless',
    outputFormat: 'text',
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: false,
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

describe('CLI root argument routing', () => {
  it('routes top-level --logout to the logout subcommand', () => {
    expect(normalizeRootShortcuts(['--logout'])).toEqual(['logout']);
  });

  it('preserves global flags when routing top-level --logout', () => {
    expect(
      normalizeRootShortcuts(['--output-format', 'json', '--logout']),
    ).toEqual(['logout', '--output-format', 'json']);
  });

  it('does not rewrite subcommand-scoped --logout flags', () => {
    expect(normalizeRootShortcuts(['chat', '--logout'])).toEqual([
      'chat',
      '--logout',
    ]);
  });

  it('does not rewrite unknown leading flags before --logout', () => {
    expect(normalizeRootShortcuts(['--unknown', '--logout'])).toEqual([
      '--unknown',
      '--logout',
    ]);
  });

  it('keeps leading global flags attached to explicit subcommands', () => {
    expect(reorderGlobalFlags(['--output-format', 'json', 'auth'])).toEqual([
      'auth',
      '--output-format',
      'json',
    ]);
  });

  it('keeps leading api-mode flags attached to explicit subcommands', () => {
    expect(
      reorderGlobalFlags(['--api-mode', 'personal', 'run', 'polish']),
    ).toEqual(['run', 'polish', '--api-mode', 'personal']);
  });

  it('keeps unknown leading flags in place for citty to report', () => {
    expect(reorderGlobalFlags(['--unknown', 'auth'])).toEqual([
      '--unknown',
      'auth',
    ]);
  });

  it('collects repeated run context flags from raw args', () => {
    expect(
      collectStringFlagValues(
        [
          'firstread',
          '-i',
          'appendix.tex',
          '-c',
          'paper.tex',
          '--context=bib.tex',
        ],
        'context',
        'c',
      ),
    ).toEqual(['paper.tex', 'bib.tex']);
  });

  it('collects repeated run input flags from raw args', () => {
    expect(
      collectStringFlagValues(
        ['firstread', '--input=Draft0.tex', '-i', 'appendices.tex'],
        'input',
        'i',
      ),
    ).toEqual(['Draft0.tex', 'appendices.tex']);
  });

  it('expands workflow input directories and globs relative to cwd', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-inputs-'));
    try {
      await fs.mkdir(path.join(root, 'paper', 'sections'), {
        recursive: true,
      });
      await fs.writeFile(path.join(root, 'paper', 'Draft0.tex'), 'draft');
      await fs.writeFile(
        path.join(root, 'paper', 'sections', 'appendix.tex'),
        'appendix',
      );
      await fs.writeFile(path.join(root, 'paper', 'notes.md'), 'notes');

      await expect(expandWorkflowInputSpecs(['paper'], root)).resolves.toEqual([
        'paper/Draft0.tex',
        'paper/sections/appendix.tex',
      ]);
      await expect(
        expandWorkflowInputSpecs(['paper/**/*.tex'], root),
      ).resolves.toEqual(['paper/Draft0.tex', 'paper/sections/appendix.tex']);
      await expect(
        expandWorkflowInputSpecs(
          [path.join(root, 'paper', 'sections', 'appendix.tex')],
          root,
        ),
      ).resolves.toEqual(['paper/sections/appendix.tex']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing workflow outputs as a failed copy operation', async () => {
    await expect(
      resolveWorkflowOutput(
        'corrected.tex',
        undefined,
        {
          status: END_GROUP_STATUS.ERROR,
          category: AgentCategory.Workflow,
          executionId: 'execution-without-output',
          streamId: 'stream-without-output',
          outputs: [],
          compileFailures: [],
        },
        cliContext(),
      ),
    ).rejects.toThrow(
      'Workflow error without a generated output; corrected.tex was not written.',
    );
  });

  it('maps stopped end-group status to completed terminal status by default', () => {
    expect(
      cliTerminalStatus({
        status: 'stopped',
      } as Parameters<typeof cliTerminalStatus>[0]),
    ).toBe(EXECUTION_STATUS.COMPLETED);
  });

  it('honors stored interrupted terminal status', () => {
    expect(
      cliTerminalStatus(
        { status: 'stopped' } as Parameters<typeof cliTerminalStatus>[0],
        EXECUTION_STATUS.INTERRUPTED,
      ),
    ).toBe(EXECUTION_STATUS.INTERRUPTED);
  });

  it('reports successful stopped workflows with missing requested outputs as failed copies', async () => {
    await expect(
      resolveWorkflowOutput(
        'corrected.tex',
        undefined,
        {
          status: END_GROUP_STATUS.STOPPED,
          category: AgentCategory.Workflow,
          executionId: 'completed-without-output',
          streamId: 'completed-stream-without-output',
          outputs: [],
          compileFailures: [],
        },
        cliContext(),
        EXECUTION_STATUS.COMPLETED,
      ),
    ).rejects.toThrow(
      'Workflow completed without a generated output; corrected.tex was not written.',
    );
  });

  it('keeps stopped workflows with missing requested outputs interrupted', async () => {
    await expect(
      resolveWorkflowOutput(
        'corrected.tex',
        undefined,
        {
          status: END_GROUP_STATUS.STOPPED,
          category: AgentCategory.Workflow,
          executionId: 'stopped-without-output',
          streamId: 'stopped-stream-without-output',
          outputs: [],
          compileFailures: [],
        },
        cliContext(),
        EXECUTION_STATUS.INTERRUPTED,
      ),
    ).resolves.toMatchObject({
      copiedOutput: undefined,
      displayResult: {
        terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      },
    });
  });

  it('formats model list network failures without raw stack traces', () => {
    const error = new Error('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND remote.texra.ai'),
    });

    expect(formatCliModelListError(error)).toBe(
      'texra: could not fetch model access metadata from remote.texra.ai: getaddrinfo ENOTFOUND remote.texra.ai',
    );
  });

  it('recognizes raw relay fetch stack logs from lower-level clients', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND remote.texra.ai'),
    });

    expect(isCliFetchStackLog([error])).toBe(true);
    expect(isCliFetchStackLog([new Error('unrelated')])).toBe(false);
  });

  it('does not force doctor into personal-key model availability', () => {
    const init = doctorPlatformInitContext(
      cliContext({ apiMode: 'included' }),
    ) as { skipIncludedModelAccess?: boolean; quietLogs?: boolean };

    expect(init.quietLogs).toBe(true);
    expect(init.skipIncludedModelAccess).toBeUndefined();
  });
});

describe('CLI login arguments', () => {
  it('prefers explicit provider flags over positional providers', () => {
    expect(resolveLoginProvider('google', 'github')).toBe('github');
  });
});

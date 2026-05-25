import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cliTerminalStatus,
  collectStringFlagValues,
  detectUnknownCliCommand,
  doctorPlatformInitContext,
  expandWorkflowInputSpecs,
  formatCliModelListError,
  formatUnknownCliCommand,
  isCliFetchStackLog,
  normalizeRootShortcuts,
  reorderGlobalFlags,
  resolveLoginProvider,
  resumeWorkflowOutputFile,
  resolveWorkflowOutput,
} from '@cli/commands/root';
import { rejectHeadlessOnlyFlags } from '@cli/commands/_helpers/globalArgs';
import { isKnownCliModel } from '@cli/runtime/cliConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { END_GROUP_STATUS, EXECUTION_STATUS } from '@shared/schemas';
import type { CliContext } from '@cli/runtime/cliContext';

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

function storedConfig(
  overrides: Partial<Parameters<typeof resumeWorkflowOutputFile>[0]> = {},
): Parameters<typeof resumeWorkflowOutputFile>[0] {
  return {
    agent: 'polish',
    model: 'deepseekT',
    inputFiles: ['paper.tex'],
    contextFiles: [],
    outputFiles: [],
    cliOutputFile: undefined,
    instruction: undefined,
    workingDirectory: '/tmp/project',
    agentCategory: AgentCategory.Workflow,
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

  it('routes top-level --resume to the resume subcommand', () => {
    expect(normalizeRootShortcuts(['--resume', 'abc123'])).toEqual([
      'resume',
      'abc123',
    ]);
  });

  it('routes inline top-level --resume values to the resume subcommand', () => {
    expect(normalizeRootShortcuts(['--resume=abc123'])).toEqual([
      'resume',
      'abc123',
    ]);
  });

  it('preserves global flags when routing top-level --resume', () => {
    expect(
      normalizeRootShortcuts(['--output-format', 'json', '--resume', 'abc123']),
    ).toEqual(['resume', 'abc123', '--output-format', 'json']);
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

  it('detects unknown top-level commands before citty falls back to help', async () => {
    await expect(detectUnknownCliCommand(['bogus'])).resolves.toEqual({
      typedCommand: 'texra bogus',
      helpCommand: 'texra',
    });
  });

  it('detects unknown command-group children', async () => {
    await expect(detectUnknownCliCommand(['agents', 'bogus'])).resolves.toEqual(
      {
        typedCommand: 'texra agents bogus',
        helpCommand: 'texra agents',
      },
    );
    await expect(
      detectUnknownCliCommand(['history', 'bogus']),
    ).resolves.toEqual({
      typedCommand: 'texra history bogus',
      helpCommand: 'texra history',
    });
    await expect(detectUnknownCliCommand(['auth', 'bogus'])).resolves.toEqual({
      typedCommand: 'texra auth bogus',
      helpCommand: 'texra auth',
    });
    await expect(detectUnknownCliCommand(['models', 'bogus'])).resolves.toEqual(
      {
        typedCommand: 'texra models bogus',
        helpCommand: 'texra models',
      },
    );
    await expect(detectUnknownCliCommand(['skills', 'bogus'])).resolves.toEqual(
      {
        typedCommand: 'texra skills bogus',
        helpCommand: 'texra skills',
      },
    );
    await expect(detectUnknownCliCommand(['tools', 'bogus'])).resolves.toEqual({
      typedCommand: 'texra tools bogus',
      helpCommand: 'texra tools',
    });
  });

  it('formats unknown command usage guidance', () => {
    expect(
      formatUnknownCliCommand({
        typedCommand: 'texra agents bogus',
        helpCommand: 'texra agents',
      }),
    ).toBe(
      'Unknown command: texra agents bogus. Run `texra agents --help` for usage.',
    );
  });

  it('does not classify known command arguments as unknown commands', async () => {
    await expect(
      detectUnknownCliCommand(['run', 'polish', '--input', 'paper.tex']),
    ).resolves.toBeUndefined();
    await expect(
      detectUnknownCliCommand(['history', 'show', 'abc123']),
    ).resolves.toBeUndefined();
    await expect(
      detectUnknownCliCommand(['completion', 'zsh']),
    ).resolves.toBeUndefined();
    await expect(
      detectUnknownCliCommand(['--unknown', 'bogus']),
    ).resolves.toBeUndefined();
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

  it('rejects headless-only flags on interactive command bodies', () => {
    expect(() => rejectHeadlessOnlyFlags(['--print'], 'chat')).toThrow(
      'texra chat is interactive',
    );
    expect(() =>
      rejectHeadlessOnlyFlags(['--output-format=json'], 'orchestrate'),
    ).toThrow('texra orchestrate is interactive');
    expect(() =>
      rejectHeadlessOnlyFlags(['--approval-policy', 'ask'], 'chat'),
    ).not.toThrow();
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

  it('rejects a literal --input file that does not exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-inputs-'));
    try {
      const missing = path.join(root, 'no-such.tex');
      // Pure path (no glob magic, not a directory) — previously this was
      // returned as-is and the workflow ran until the agent ENOENT'd.
      await expect(expandWorkflowInputSpecs([missing], root)).rejects.toThrow(
        /--input: file not found/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('attributes the missing-path error to the caller-supplied flag label', async () => {
    // The helper is shared between --input (texra run, multi-agent run input)
    // and --context (multi-agent run context). The error must name the flag
    // the user actually passed, not always say --input.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-flag-'));
    try {
      const missing = path.join(root, 'no-such-context.tex');
      await expect(
        expandWorkflowInputSpecs([missing], root, '--context'),
      ).rejects.toThrow(/--context: file not found/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('expands a glob --context spec the same way --input does', async () => {
    // `texra run -c '<glob>'` previously stuffed the literal glob string into
    // the AgentConfig and failed late with raw ENOENT (exit 1). Routing
    // through expandWorkflowInputSpecs gives it the same expansion semantics
    // as `--input` (and surfaces missing-path errors as Usage / exit 2).
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-ctx-'));
    try {
      await fs.writeFile(path.join(root, 'a.bib'), 'a');
      await fs.writeFile(path.join(root, 'b.bib'), 'b');
      await expect(
        expandWorkflowInputSpecs([path.join(root, '*.bib')], root, '--context'),
      ).resolves.toEqual(['a.bib', 'b.bib']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Skip on Windows (no POSIX chmod semantics) and when running as root, where
  // mode-0 doesn't block stat.
  const skipPermissionTest =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);
  (skipPermissionTest ? it.skip : it)(
    'propagates non-ENOENT stat errors instead of misreporting as not-found',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-cli-perm-'));
      const blocked = path.join(root, 'blocked');
      const inner = path.join(blocked, 'paper.tex');
      try {
        await fs.mkdir(blocked, { recursive: true });
        await fs.writeFile(inner, 'draft');
        // Strip search/execute permission on the parent so stat(inner) fails
        // with EACCES. The not-found fast path must not swallow this.
        await fs.chmod(blocked, 0o000);
        await expect(expandWorkflowInputSpecs([inner], root)).rejects.toThrow(
          /(EACCES|permission)/i,
        );
      } finally {
        await fs.chmod(blocked, 0o755).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

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

  it('restores one requested workflow output path for resume', () => {
    expect(
      resumeWorkflowOutputFile(
        storedConfig({ outputFiles: ['paper.polished.tex'] }),
      ),
    ).toBe(path.join('/tmp/project', 'paper.polished.tex'));
  });

  it('restores the exact absolute CLI output target for resume', () => {
    expect(
      resumeWorkflowOutputFile(
        storedConfig({
          cliOutputFile: '/tmp/elsewhere/paper.polished.tex',
          outputFiles: ['paper.polished.tex'],
        }),
      ),
    ).toBe('/tmp/elsewhere/paper.polished.tex');
  });

  it('resolves relative CLI output targets against the stored working directory', () => {
    expect(
      resumeWorkflowOutputFile(
        storedConfig({
          cliOutputFile: 'out/paper.polished.tex',
          outputFiles: ['paper.polished.tex'],
        }),
      ),
    ).toBe(path.join('/tmp/project', 'out/paper.polished.tex'));
  });

  it('keeps legacy resume output paths relative when no stored working directory exists', () => {
    expect(
      resumeWorkflowOutputFile(
        storedConfig({
          workingDirectory: undefined,
          outputFiles: ['paper.polished.tex'],
        }),
      ),
    ).toBe('paper.polished.tex');
  });

  it('does not infer resume output targets for multi-output workflows', () => {
    expect(
      resumeWorkflowOutputFile(
        storedConfig({ outputFiles: ['paper.tex', 'appendix.tex'] }),
      ),
    ).toBeUndefined();
  });

  it('does not infer resume output targets for tool-use configs', () => {
    expect(
      resumeWorkflowOutputFile(
        storedConfig({
          agentCategory: AgentCategory.ToolUse,
          outputFiles: ['paper.polished.tex'],
        }),
      ),
    ).toBeUndefined();
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
        { terminalStatus: EXECUTION_STATUS.COMPLETED },
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
        { terminalStatus: EXECUTION_STATUS.INTERRUPTED },
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

describe('CLI model flag validation contract', () => {
  it('classifies built-in models as known and bogus names as unknown', () => {
    expect(isKnownCliModel('sonnet46T')).toBe(true);
    expect(isKnownCliModel('deepseekT')).toBe(true);
    expect(isKnownCliModel('nonexistent-model-xyz')).toBe(false);
    expect(isKnownCliModel('')).toBe(false);
  });
});

describe('CLI login arguments', () => {
  it('prefers explicit provider flags over positional providers', () => {
    expect(resolveLoginProvider('google', 'github')).toBe('github');
  });
});

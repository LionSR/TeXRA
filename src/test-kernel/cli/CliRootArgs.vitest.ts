import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasMagic } from 'glob';
import stripAnsi from 'strip-ansi';

import { rootCommand, runCli } from '@cli/commands/root';
import { doctorPlatformInitContext } from '@cli/commands/doctor';
import {
  normalizeRootShortcuts,
  reorderGlobalFlags,
  hasUsageNoColorFlag,
  detectUnknownCliCommand,
  detectUnknownCliFlag,
  formatUnknownCliCommand,
  formatUnknownCliFlag,
} from '@cli/commands/_helpers/dispatch';
import { CliUsageError, formatCrashReportLine } from '@cli/runtime/cliContext';
import {
  formatCliModelListError,
  isCliFetchStackLog,
} from '@cli/commands/_helpers/fetchSilencer';
import {
  collectStringFlagValues,
  GLOBAL_BOOL_FLAGS,
  GLOBAL_VALUE_FLAGS,
  optionalStringFlagValue,
  rejectHeadlessOnlyFlags,
} from '@cli/commands/_helpers/globalArgs';
import {
  createStdinWorkflowInputMaterializer,
  expandRunInputs,
  expandWorkflowInputSpecs,
  hasMixedStdinWorkflowInputSpecs,
  isMaterializedStdinWorkflowInputPath,
  workflowInputGlobOptions,
} from '@cli/runtime/workflowInputs';
import {
  resolveWorkflowOutput,
  resumeWorkflowOutputFile,
  resumeWorkflowOutputDirectory,
} from '@cli/runtime/workflowOutput';
import {
  isCliSupportedModelId,
  knownCliModelIds,
  resolveKnownCliModelId,
} from '@cli/runtime/cliConfig';
import type { CliContext } from '@cli/runtime/cliContext';
import { pickGlobalArgs } from '@cli/runtime/globalArgs';
import { RUN_OUTCOME, AgentCategory } from '@shared/schemas';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    renderRunProgress: true,
    ...overrides,
  });
}

type StoredResumeConfig = Parameters<typeof resumeWorkflowOutputFile>[0];

function storedConfig(
  overrides: Partial<StoredResumeConfig> = {},
): StoredResumeConfig {
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

async function initNodeBackedPlatform(options: {
  storagePath: string;
  globalStoragePath: string;
}): Promise<void> {
  const [{ initPlatform }, { nodeFilesystem }, { createFakePlatform }] =
    await Promise.all([
      import('@platform/platform'),
      import('@platform/defaults/nodeFilesystem'),
      import('@test/support/FakePlatform'),
    ]);
  initPlatform(
    createFakePlatform(
      {
        workspacePath: process.cwd(),
        storagePath: options.storagePath,
        globalStoragePath: options.globalStoragePath,
      },
      { fs: nodeFilesystem },
    ),
  );
}

async function initDefaultFakePlatform(): Promise<void> {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform());
}

async function withTempDir<T>(
  prefix: string,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withExternalDirs(
  run: (root: string, externalDir: string) => Promise<void>,
): Promise<void> {
  await withTempDir('texra-cli-inputs-', async (root) => {
    await withTempDir('texra-cli-external-', async (externalDir) => {
      await run(root, externalDir);
    });
  });
}

const STDIN_DOCUMENT =
  '\\documentclass{article}\\begin{document}Hi\\end{document}';

function trackedStdinMaterializer(
  root: string,
  body: string = STDIN_DOCUMENT,
): {
  stdinInputFile: ReturnType<typeof createStdinWorkflowInputMaterializer>;
  readCount: () => number;
} {
  let reads = 0;
  const stdinInputFile = createStdinWorkflowInputMaterializer({
    tempDir: root,
    readStdinText: async () => {
      reads += 1;
      return body;
    },
  });
  return { stdinInputFile, readCount: () => reads };
}

describe('CLI root argument routing', () => {
  it('routes top-level version shortcuts to the version command', () => {
    expect(normalizeRootShortcuts(['--version'])).toEqual(['version']);
    expect(normalizeRootShortcuts(['--no-color', '-v'])).toEqual([
      'version',
      '--no-color',
    ]);
    expect(normalizeRootShortcuts(['-V', '--no-color'])).toEqual([
      'version',
      '--no-color',
    ]);
  });

  it('does not rewrite subcommand-scoped shortcut flags', () => {
    expect(normalizeRootShortcuts(['chat', '--version'])).toEqual([
      'chat',
      '--version',
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

  it('does not rewrite unknown leading flags before a shortcut', () => {
    expect(normalizeRootShortcuts(['--unknown', '--version'])).toEqual([
      '--unknown',
      '--version',
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

  it('keeps leading source flags attached to agent subcommands', () => {
    expect(
      reorderGlobalFlags(['--source', 'vendor/skills', 'run', 'polish']),
    ).toEqual(['run', 'polish', '--source', 'vendor/skills']);
    expect(
      reorderGlobalFlags(['-s', 'vendor/skills', 'run', 'polish']),
    ).toEqual(['run', 'polish', '-s', 'vendor/skills']);
    expect(reorderGlobalFlags(['--include-interop', 'chat'])).toEqual([
      'chat',
      '--include-interop',
    ]);
  });

  it('keeps unknown leading flags in place for citty to report', () => {
    expect(reorderGlobalFlags(['--unknown', 'auth'])).toEqual([
      '--unknown',
      'auth',
    ]);
  });

  it('detects unknown top-level commands before citty falls back to help', async () => {
    await expect(
      detectUnknownCliCommand(rootCommand, ['bogus']),
    ).resolves.toEqual({
      typedCommand: 'texra bogus',
      helpCommand: 'texra',
    });
  });

  it('suggests close command names for mistyped top-level commands', async () => {
    await expect(
      detectUnknownCliCommand(rootCommand, ['chatt']),
    ).resolves.toEqual({
      typedCommand: 'texra chatt',
      helpCommand: 'texra',
      suggestedCommand: 'texra chat',
    });
  });

  it('detects unknown command-group children', async () => {
    for (const group of [
      'agents',
      'history',
      'auth',
      'models',
      'skills',
      'tools',
    ]) {
      await expect(
        detectUnknownCliCommand(rootCommand, [group, 'bogus']),
      ).resolves.toEqual({
        typedCommand: `texra ${group} bogus`,
        helpCommand: `texra ${group}`,
      });
    }
  });

  it('suggests close command names inside command groups', async () => {
    await expect(
      detectUnknownCliCommand(rootCommand, ['multi-agent', 'rn']),
    ).resolves.toEqual({
      typedCommand: 'texra multi-agent rn',
      helpCommand: 'texra multi-agent',
      suggestedCommand: 'texra multi-agent run',
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

  it('formats typo suggestions for unknown commands', () => {
    expect(
      formatUnknownCliCommand({
        typedCommand: 'texra chatt',
        helpCommand: 'texra',
        suggestedCommand: 'texra chat',
      }),
    ).toBe(
      'Unknown command: texra chatt. Did you mean `texra chat`? Run `texra --help` for usage.',
    );
  });

  it('detects unknown command-scoped flags before command execution', async () => {
    await expect(
      detectUnknownCliFlag(rootCommand, ['doctor', '--bogus']),
    ).resolves.toEqual({
      flag: '--bogus',
      helpCommand: 'texra doctor',
    });
    await expect(
      detectUnknownCliFlag(rootCommand, [
        'models',
        'list',
        '--unknown',
        '--no-input',
        '--output-format',
        'json',
      ]),
    ).resolves.toEqual({
      flag: '--unknown',
      helpCommand: 'texra models list',
    });
    await expect(
      detectUnknownCliFlag(rootCommand, ['--bogus', 'doctor']),
    ).resolves.toEqual({
      flag: '--bogus',
      helpCommand: 'texra doctor',
    });
  });

  it('does not classify flag values or known aliases as unknown flags', async () => {
    for (const args of [
      ['run', 'polish', '--instruction', '--literal'],
      ['run', 'polish', '-mdeepseekT', '--no-color'],
      ['setup', '--no-input'],
      ['resume', 'abc123', '--print'],
      ['multi-agent', 'run', 'mathematician', '--instruction-file=prompt.md'],
      ['run', 'polish', '--input', 'paper.tex', '--instruction-file=prompt.md'],
    ]) {
      await expect(
        detectUnknownCliFlag(rootCommand, args),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects camelCase spellings for kebab-case flags', async () => {
    await expect(
      detectUnknownCliFlag(rootCommand, [
        'models',
        'list',
        '--outputFormat',
        'json',
      ]),
    ).resolves.toEqual({
      flag: '--outputFormat',
      helpCommand: 'texra models list',
    });
  });

  it('validates help command paths against the displayed command', async () => {
    await expect(
      detectUnknownCliFlag(rootCommand, [
        'help',
        'models',
        'list',
        '--unknown',
      ]),
    ).resolves.toEqual({
      flag: '--unknown',
      helpCommand: 'texra models list',
    });
    await expect(
      detectUnknownCliFlag(rootCommand, [
        'help',
        'models',
        'list',
        '--no-input',
        '--output-format',
        'json',
      ]),
    ).resolves.toBeUndefined();
  });

  it('formats unknown flag usage guidance', () => {
    expect(
      formatUnknownCliFlag({
        flag: '--bogus',
        helpCommand: 'texra doctor',
      }),
    ).toBe('Unknown option: --bogus. Run `texra doctor --help` for usage.');
  });

  it('does not classify known command arguments as unknown commands', async () => {
    for (const args of [
      ['run', 'polish', '--input', 'paper.tex'],
      ['history', 'show', 'abc123'],
      ['completion', 'zsh'],
      ['--unknown', 'bogus'],
    ]) {
      await expect(
        detectUnknownCliCommand(rootCommand, args),
      ).resolves.toBeUndefined();
    }
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

  it('rejects file flags when the next token is another option', () => {
    expect(() =>
      collectStringFlagValues(
        ['firstread', '--input', '--print'],
        'input',
        'i',
      ),
    ).toThrow('Missing value for --input');
    expect(() =>
      collectStringFlagValues(['firstread', '-i', '-p'], 'input', 'i'),
    ).toThrow('Missing value for -i');
  });

  it('rejects file flags with empty inline values', () => {
    expect(() =>
      collectStringFlagValues(['firstread', '--input='], 'input', 'i'),
    ).toThrow('Missing value for --input');
  });

  it('preserves bare dash as a file flag stdin value', () => {
    expect(
      collectStringFlagValues(['firstread', '--input', '-'], 'input', 'i'),
    ).toEqual(['-']);
  });

  it('reads optional file flags from raw args with the same value guard', () => {
    expect(
      optionalStringFlagValue(['firstread', '--output', 'out.tex'], 'output'),
    ).toBe('out.tex');
    expect(
      optionalStringFlagValue(
        ['review', '--instruction-file=prompt.md'],
        'instruction-file',
      ),
    ).toBe('prompt.md');
    expect(
      optionalStringFlagValue(['firstread', '--output', '-'], 'output'),
    ).toBe('-');
    expect(() =>
      optionalStringFlagValue(
        ['review', '--instruction-file', '--print'],
        'instruction-file',
      ),
    ).toThrow('Missing value for --instruction-file');
    expect(() =>
      optionalStringFlagValue(['firstread', '--output='], 'output'),
    ).toThrow('Missing value for --output');
  });

  it('rejects headless-only flags on interactive command bodies', () => {
    const rejected: Array<[string[], string, string]> = [
      [
        ['--print'],
        'chat',
        'texra chat is interactive and does not support --print.',
      ],
      [
        ['-p'],
        'chat',
        'texra chat is interactive and does not support --print.',
      ],
      [
        ['--output-format=json'],
        'orchestrate',
        'texra orchestrate is interactive and does not support --output-format.',
      ],
      [
        ['--no-input'],
        'chat',
        'texra chat is interactive and does not support --no-input.',
      ],
      [
        ['--no-input=true'],
        'chat',
        'texra chat is interactive and does not support --no-input.',
      ],
      [
        ['--print=true'],
        'chat',
        'texra chat is interactive and does not support --print.',
      ],
      [
        ['--print', '--output-format', 'json', '--no-input'],
        'chat',
        'texra chat is interactive and does not support --print, --output-format, and --no-input.',
      ],
    ];

    for (const [args, command, message] of rejected) {
      expect(() => rejectHeadlessOnlyFlags(args, command)).toThrow(message);
    }
    expect(() =>
      rejectHeadlessOnlyFlags(['--approval-policy', 'ask'], 'chat'),
    ).not.toThrow();
  });

  it('expands workflow input directories and globs relative to cwd', async () => {
    await withTempDir('texra-cli-inputs-', async (root) => {
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
    });
  });

  it('rejects a literal --input file that does not exist', async () => {
    await withTempDir('texra-cli-inputs-', async (root) => {
      const missing = path.join(root, 'no-such.tex');
      // A pure path (no glob magic, not a directory) is validated here rather
      // than handed to the workflow to fail on later with a raw ENOENT.
      await expect(expandWorkflowInputSpecs([missing], root)).rejects.toThrow(
        /--input: file not found/,
      );
    });
  });

  it('materializes stdin when --input - is passed', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      const { stdinInputFile, readCount } = trackedStdinMaterializer(
        root,
        '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n',
      );

      const expanded = await expandWorkflowInputSpecs(
        ['-', '-'],
        root,
        '--input',
        {
          stdinInputFile,
        },
      );

      expect(expanded).toHaveLength(1);
      expect(readCount()).toBe(1);
      expect(path.basename(expanded[0])).toBe('stdin.tex');
      expect(isMaterializedStdinWorkflowInputPath(expanded[0])).toBe(true);
      await expect(
        fs.readFile(path.resolve(root, expanded[0]), 'utf8'),
      ).resolves.toContain('\\begin{document}Hi');
      await stdinInputFile.cleanup();
      await expect(fs.stat(path.resolve(root, expanded[0]))).rejects.toThrow();
      await expect(
        fs.stat(path.dirname(path.resolve(root, expanded[0]))),
      ).rejects.toThrow();
    });
  });

  it('preserves stdin position when mixed with file inputs', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      await fs.writeFile(path.join(root, 'paper.tex'), 'paper');
      const { stdinInputFile } = trackedStdinMaterializer(root);

      const expanded = await expandWorkflowInputSpecs(
        ['-', 'paper.tex'],
        root,
        '--input',
        {
          stdinInputFile,
        },
      );

      expect(path.basename(expanded[0])).toBe('stdin.tex');
      expect(isMaterializedStdinWorkflowInputPath(expanded[0])).toBe(true);
      expect(expanded[1]).toBe('paper.tex');
    });
  });

  it('rejects empty stdin input', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      const { stdinInputFile } = trackedStdinMaterializer(root, ' \n\t ');

      await expect(
        expandWorkflowInputSpecs(['-'], root, '--input', { stdinInputFile }),
      ).rejects.toThrow(/stdin: no data on stdin/);
    });
  });

  it('detects stdin mixed with other raw workflow input specs', () => {
    expect(hasMixedStdinWorkflowInputSpecs(['-'])).toBe(false);
    expect(hasMixedStdinWorkflowInputSpecs(['-', '-'])).toBe(false);
    expect(hasMixedStdinWorkflowInputSpecs(['-', 'paper.tex'])).toBe(true);
    expect(hasMixedStdinWorkflowInputSpecs(['  -  ', 'paper.tex'])).toBe(true);
  });

  it('does not classify ordinary stdin-named files as materialized stdin', () => {
    expect(isMaterializedStdinWorkflowInputPath('stdin.tex')).toBe(false);
    expect(
      isMaterializedStdinWorkflowInputPath('texra-stdin-workflow/stdin.tex'),
    ).toBe(false);
    expect(
      isMaterializedStdinWorkflowInputPath(
        'texra-stdin-123-workflow/stdin.tex',
      ),
    ).toBe(false);
  });

  it('does not read stdin before later --input validation errors', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      const { stdinInputFile, readCount } = trackedStdinMaterializer(root);

      await expect(
        expandWorkflowInputSpecs(['-', 'missing.tex'], root, '--input', {
          stdinInputFile,
        }),
      ).rejects.toThrow(/--input: file not found: missing\.tex/);
      expect(readCount()).toBe(0);
    });
  });

  it('does not read stdin before --context validation errors', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      const { stdinInputFile, readCount } = trackedStdinMaterializer(root);

      await expect(
        expandRunInputs(['-'], ['missing-context.tex'], root, {
          stdinInputFile,
        }),
      ).rejects.toThrow(/--context: file not found: missing-context\.tex/);
      expect(readCount()).toBe(0);
    });
  });

  it('materializes stdin for --context - when input is a normal file', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      await fs.writeFile(path.join(root, 'main.tex'), 'main');
      const { stdinInputFile } = trackedStdinMaterializer(root, 'context body');

      const { inputFiles, contextFiles } = await expandRunInputs(
        ['main.tex'],
        ['-'],
        root,
        { stdinInputFile },
      );

      expect(inputFiles).toEqual(['main.tex']);
      expect(contextFiles).toHaveLength(1);
      expect(path.basename(contextFiles[0])).toBe('stdin.tex');
      expect(isMaterializedStdinWorkflowInputPath(contextFiles[0])).toBe(true);
      await expect(
        fs.readFile(path.resolve(root, contextFiles[0]), 'utf8'),
      ).resolves.toBe('context body');
    });
  });

  it('rejects stdin across both input and context with a clear usage error', async () => {
    await withTempDir('texra-cli-stdin-', async (root) => {
      const { stdinInputFile } = trackedStdinMaterializer(root, 'piped body');
      await expect(
        expandRunInputs(['-'], ['-'], root, { stdinInputFile }),
      ).rejects.toThrow(/Use `-` for either --input or --context/);
    });
  });

  it('rejects external files when tool-use runs require workspace files', async () => {
    await withExternalDirs(async (root, externalDir) => {
      const external = path.join(externalDir, 'problem.md');
      await fs.writeFile(external, 'outside');

      await expect(
        expandRunInputs([external], [], root, { requireWorkspaceFiles: true }),
      ).rejects.toThrow(/--input: file is outside --cwd:/);
    });
  });

  it('rejects external directories before globbing their contents', async () => {
    await withExternalDirs(async (root, externalDir) => {
      await expect(
        expandRunInputs([externalDir], [], root, {
          requireWorkspaceFiles: true,
        }),
      ).rejects.toThrow(/--input: file is outside --cwd:/);
    });
  });

  it('uses the caller flag label when rejecting external stdin materialization', async () => {
    await withExternalDirs(async (root, externalDir) => {
      const external = path.join(externalDir, 'stdin.md');
      await fs.writeFile(external, 'outside');

      await expect(
        expandWorkflowInputSpecs(['-'], root, '--context', {
          requireWorkspaceFiles: true,
          stdinInputFile: async () => external,
        }),
      ).rejects.toThrow(/--context: file is outside --cwd:/);
    });
  });

  it('attributes the missing-path error to the caller-supplied flag label', async () => {
    // The helper is shared between --input (texra run, multi-agent run input)
    // and --context (multi-agent run context). The error must name the flag
    // the user actually passed, not always say --input.
    await withTempDir('texra-cli-flag-', async (root) => {
      const missing = path.join(root, 'no-such-context.tex');
      await expect(
        expandWorkflowInputSpecs([missing], root, '--context'),
      ).rejects.toThrow(/--context: file not found/);
    });
  });

  it('expands a glob --context spec the same way --input does', async () => {
    // `texra run -c '<glob>'` routes through expandWorkflowInputSpecs, so it
    // has the same expansion semantics as `--input` and surfaces missing-path
    // errors as Usage (exit 2) instead of a late raw ENOENT.
    await withTempDir('texra-cli-ctx-', async (root) => {
      await fs.writeFile(path.join(root, 'a.bib'), 'a');
      await fs.writeFile(path.join(root, 'b.bib'), 'b');
      await expect(
        expandWorkflowInputSpecs([path.join(root, '*.bib')], root, '--context'),
      ).resolves.toEqual(['a.bib', 'b.bib']);
    });
  });

  it('selects platform-specific backslash glob semantics', () => {
    const pattern = String.raw`refs\*.bib`;

    expect(hasMagic(pattern, workflowInputGlobOptions('win32'))).toBe(true);
    expect(hasMagic(pattern, workflowInputGlobOptions('linux'))).toBe(false);
  });

  it('prefers an exact filename containing glob syntax', async () => {
    await withTempDir('texra-cli-literal-magic-', async (root) => {
      await fs.mkdir(path.join(root, 'refs'));
      await fs.writeFile(path.join(root, 'refs', '[ab].bib'), 'literal');
      await fs.writeFile(path.join(root, 'refs', 'a.bib'), 'glob match');

      await expect(
        expandWorkflowInputSpecs([path.join('refs', '[ab].bib')], root),
      ).resolves.toEqual(['refs/[ab].bib']);
    });
  });

  it('expands host-native globs for both --input and --context', async () => {
    await withTempDir('texra-cli-native-glob-', async (root) => {
      await fs.mkdir(path.join(root, 'refs'));
      await fs.writeFile(path.join(root, 'refs', 'zeta.bib'), 'zeta');
      await fs.writeFile(path.join(root, 'refs', 'alpha.bib'), 'alpha');
      await fs.writeFile(path.join(root, 'refs', 'notes.md'), 'notes');
      const pattern = path.join('refs', '*.bib');

      await expect(
        expandRunInputs([pattern], [pattern], root),
      ).resolves.toEqual({
        inputFiles: ['refs/alpha.bib', 'refs/zeta.bib'],
        contextFiles: ['refs/alpha.bib', 'refs/zeta.bib'],
      });
    });
  });

  (process.platform === 'win32' ? it : it.skip)(
    'expands an absolute drive-letter glob',
    async () => {
      await withTempDir('texra-cli-drive-glob-', async (root) => {
        await fs.mkdir(path.join(root, 'refs'));
        await fs.writeFile(path.join(root, 'refs', 'paper.bib'), 'paper');
        const pattern = path.join(root, 'refs', '*.bib');

        expect(pattern).toMatch(/^[A-Za-z]:\\/);
        await expect(
          expandWorkflowInputSpecs([pattern], root),
        ).resolves.toEqual(['refs/paper.bib']);
      });
    },
  );

  (process.platform === 'win32' ? it.skip : it)(
    'preserves POSIX glob escapes for literal metacharacters',
    async () => {
      await withTempDir('texra-cli-escaped-glob-', async (root) => {
        await fs.mkdir(path.join(root, 'refs'));
        await fs.writeFile(path.join(root, 'refs', '[ab]-one.bib'), 'literal');
        await fs.writeFile(path.join(root, 'refs', 'a-one.bib'), 'class match');

        await expect(
          expandWorkflowInputSpecs([String.raw`refs/\[ab]-*.bib`], root),
        ).resolves.toEqual(['refs/[ab]-one.bib']);
      });
    },
  );

  it('detects brace-only workflow globs', async () => {
    await withTempDir('texra-cli-brace-glob-', async (root) => {
      await fs.mkdir(path.join(root, 'refs'));
      await fs.writeFile(path.join(root, 'refs', 'beta.bib'), 'beta');
      await fs.writeFile(path.join(root, 'refs', 'alpha.bib'), 'alpha');

      await expect(
        expandWorkflowInputSpecs(['refs/{alpha,beta}.bib'], root),
      ).resolves.toEqual(['refs/alpha.bib', 'refs/beta.bib']);
    });
  });

  it('attributes unmatched globs to the original input or context flag', async () => {
    await withTempDir('texra-cli-unmatched-glob-', async (root) => {
      const pattern = path.join('missing refs', '*.bib');

      await expect(
        expandWorkflowInputSpecs([`  ${pattern}  `], root),
      ).rejects.toThrow(`--input: no files matched: ${pattern}`);
      await expect(
        expandWorkflowInputSpecs([`  ${pattern}  `], root, '--context'),
      ).rejects.toThrow(`--context: no files matched: ${pattern}`);
    });
  });

  it('reports missing workflow outputs as a failed copy operation', async () => {
    await expect(
      resolveWorkflowOutput(
        'corrected.tex',
        undefined,
        {
          outcome: RUN_OUTCOME.FAILED,
          category: AgentCategory.Workflow,
          executionId: 'execution-without-output',
          streamId: 'stream-without-output',
          outputs: [],
          compileFailures: [],
        },
        cliContext(),
        {},
      ),
    ).rejects.toThrow(
      'Workflow error without a generated output; corrected.tex was not written.',
    );
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

  it('preserves whitespace in stored workflow output and workspace paths', () => {
    const workingDirectory = path.join(path.sep, 'tmp', 'project ');
    expect(
      resumeWorkflowOutputFile(
        storedConfig({
          workingDirectory,
          cliOutputFile: ' output.tex ',
        }),
      ),
    ).toBe(path.join(workingDirectory, ' output.tex '));
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

  it('restores a relative CLI output directory against the stored workspace', () => {
    expect(
      resumeWorkflowOutputDirectory(
        storedConfig({ cliOutputDirectory: 'out/polished' }),
      ),
    ).toBe(path.join('/tmp/project', 'out/polished'));
  });

  it('reports successful stopped workflows with missing requested outputs as failed copies', async () => {
    await expect(
      resolveWorkflowOutput(
        'corrected.tex',
        undefined,
        {
          outcome: RUN_OUTCOME.COMPLETED,
          category: AgentCategory.Workflow,
          executionId: 'completed-without-output',
          streamId: 'completed-stream-without-output',
          outputs: [],
          compileFailures: [],
        },
        cliContext(),
        {},
      ),
    ).rejects.toThrow(
      'Workflow completed without a generated output; corrected.tex was not written.',
    );
  });

  it('keeps stopped workflows with missing requested outputs interrupted', async () => {
    const result = await resolveWorkflowOutput(
      'corrected.tex',
      undefined,
      {
        outcome: RUN_OUTCOME.CANCELLED,
        category: AgentCategory.Workflow,
        executionId: 'stopped-without-output',
        streamId: 'stopped-stream-without-output',
        outputs: [],
        compileFailures: [],
      },
      cliContext(),
      {},
    );

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.CANCELLED,
    });
    expect(Object.hasOwn(result, 'terminalStatus')).toBe(false);
    expect(Object.hasOwn(result, 'copiedOutput')).toBe(false);
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

describe('CLI global color/input flags', () => {
  it('maps CLI color and no-input flags to canonical knobs', () => {
    expect(pickGlobalArgs({ color: false, 'no-input': true })).toMatchObject({
      noColor: true,
      noInput: true,
    });
  });

  it('maps citty negated input output to --no-input', () => {
    expect(pickGlobalArgs({ input: false })).toMatchObject({
      noInput: true,
    });
    expect(pickGlobalArgs({ input: 'file.tex' })).toMatchObject({
      noInput: false,
    });
  });

  it('treats absent/default color and no-input flags as not negated', () => {
    expect(pickGlobalArgs({ color: true, 'no-input': false })).toMatchObject({
      noColor: false,
      noInput: false,
    });
    // Absent flags default to "not negated" too.
    expect(pickGlobalArgs({})).toMatchObject({
      noColor: false,
      noInput: false,
    });
  });

  it('maps runtime source flags to canonical knobs', () => {
    expect(
      pickGlobalArgs(
        {
          'include-interop': true,
          source: 'fallback/skills',
        },
        { skillSourcePaths: ['vendor/skills', '/tmp/shared-skills'] },
      ),
    ).toMatchObject({
      includeInteropSkills: true,
      skillSourcePaths: ['vendor/skills', '/tmp/shared-skills'],
    });
    expect(
      pickGlobalArgs({ source: ['one/skills', 'two/skills'] }),
    ).toMatchObject({
      includeInteropSkills: false,
      skillSourcePaths: ['one/skills', 'two/skills'],
    });
  });

  it('registers global boolean spellings without stealing --input', () => {
    // Needed so `texra --no-color agents list` and
    // `texra --no-input agents list` reorder/dispatch correctly.
    expect(GLOBAL_BOOL_FLAGS.has('--no-color')).toBe(true);
    expect(GLOBAL_BOOL_FLAGS.has('--no-input')).toBe(true);
    expect(GLOBAL_BOOL_FLAGS.has('--include-interop')).toBe(true);
    expect(GLOBAL_VALUE_FLAGS.has('--source')).toBe(true);
    expect(GLOBAL_VALUE_FLAGS.has('-s')).toBe(true);
    expect(GLOBAL_BOOL_FLAGS.has('--input')).toBe(false);
  });

  it('detects usage --no-color only as a global flag', () => {
    expect(hasUsageNoColorFlag(['--no-color', '--help'])).toBe(true);
    expect(hasUsageNoColorFlag(['--cwd', '--no-color', '--help'])).toBe(false);
    expect(hasUsageNoColorFlag(['--', '--no-color', '--help'])).toBe(false);
  });

  it('does not treat command-specific --input as a leading global flag', () => {
    expect(
      reorderGlobalFlags(['--input', 'file.tex', 'run', 'polish']),
    ).toEqual(['--input', 'file.tex', 'run', 'polish']);
  });
});

describe('CLI model flag validation contract', () => {
  it('classifies built-in models as known and bogus names as unknown', () => {
    expect(isCliSupportedModelId('sonnet46T')).toBe(true);
    expect(isCliSupportedModelId('deepseekT')).toBe(true);
    expect(isCliSupportedModelId('nonexistent-model-xyz')).toBe(false);
    expect(isCliSupportedModelId('')).toBe(false);
  });

  it('does not advertise host-only Copilot models as CLI models', () => {
    expect(isCliSupportedModelId('copilot4o')).toBe(false);
    expect(knownCliModelIds()).not.toContain('copilot4o');
    expect(resolveKnownCliModelId('copilot4o')).toBeUndefined();
    expect(resolveKnownCliModelId('Copilot GPT-4o')).toBeUndefined();
  });

  it('recognizes Kimi Code membership models', () => {
    expect(knownCliModelIds()).toEqual(
      expect.arrayContaining(['kimiCoding', 'kimiCodingFast']),
    );
    expect(resolveKnownCliModelId('kimi-for-coding')).toBe('kimiCoding');
    expect(resolveKnownCliModelId('Kimi for Coding')).toBe('kimiCoding');
  });
});

describe('CLI crash report line', () => {
  const bugsUrl = 'https://github.com/texra-ai/texra-issues/issues';

  it('points unexpected crashes at the issue tracker', () => {
    expect(formatCrashReportLine(new Error('boom'), bugsUrl)).toBe(
      `This looks like a bug — please report it at ${bugsUrl} (include the command and the message above).`,
    );
  });

  it('does not append a report link for usage errors', () => {
    expect(
      formatCrashReportLine(new CliUsageError('bad flag'), bugsUrl),
    ).toBeUndefined();
  });

  it('omits the report link when no tracker URL is configured', () => {
    expect(formatCrashReportLine(new Error('boom'), undefined)).toBeUndefined();
  });
});

describe('runCli usage output stream routing', () => {
  // Capture every byte the CLI writes. Usage on an ERROR flows through
  // writeRawStderr -> process.stderr.write; citty's showUsage (the explicit
  // --help path) flows through console.log -> process.stdout.write. We stub
  // both stream writers AND console.* so nothing leaks to the real terminal.
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let platformStorageRoot = '';

  beforeEach(async () => {
    platformStorageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-cli-root-'),
    );
    await initNodeBackedPlatform({
      storagePath: path.join(platformStorageRoot, 'storage'),
      globalStoragePath: path.join(platformStorageRoot, 'global-storage'),
    });
    stdout = '';
    stderr = '';
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
    // citty's showUsage writes via console.log; its errors via console.error.
    consoleLogSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        stdout += `${args.join(' ')}\n`;
      });
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        stderr += `${args.join(' ')}\n`;
      });
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (platformStorageRoot) {
      await fs.rm(platformStorageRoot, { recursive: true, force: true });
      platformStorageRoot = '';
    }
    await initDefaultFakePlatform();
  });

  function expectOk(result: { exitCode: number }): void {
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
  }

  function expectUsageError(
    result: { exitCode: number },
    message: string,
  ): void {
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(message);
    expect(stdout).toBe('');
  }

  it('routes usage text to stderr (not stdout) on a usage error', async () => {
    // Regression guard for the headless-parity contract: usage shown because
    // of an ERROR must not land on STDOUT, or it pollutes
    // `--output-format json|ndjson` (e.g. `texra run ... | jq`).
    // Mirrors the documented repro: a usage error under --output-format json.
    const result = await runCli(['run', 'badagent', '--output-format', 'json']);
    expectUsageError(result, 'Missing required argument: --input');
    // Usage banner goes to the diagnostic stream alongside the error line.
    expect(stderr).toContain('USAGE');
  });

  it('prints explicit --help usage to stdout, not stderr', async () => {
    // Unix convention: an explicit `--help` request is normal output (STDOUT).
    // Only usage shown on an error is diagnostic (STDERR). This must not
    // regress when fixing the error path.
    const result = await runCli(['run', '--help']);
    expectOk(result);
    expect(stdout).toContain('USAGE');
  });

  it('rejects unknown commands before honoring explicit --help', async () => {
    const result = await runCli(['workflows', '--help']);
    expectUsageError(
      result,
      'Unknown command: texra workflows. Run `texra --help` for usage.',
    );
  });

  it('points run-command agent arguments at the full agent catalog', async () => {
    let result = await runCli(['run', '--help']);
    expectOk(result);
    expect(stdout).toContain(
      'Workflow agent name from `texra agents list --category workflow --all`',
    );

    stdout = '';
    stderr = '';
    result = await runCli(['agents', 'run', '--help']);
    expectOk(result);
    expect(stdout).toContain(
      'Tool-use agent name from `texra agents list --category toolUse --all`',
    );
  });

  it('rejects unknown flags before running command bodies', async () => {
    const result = await runCli(['doctor', '--bogus', '--no-input']);
    expectUsageError(
      result,
      'Unknown option: --bogus. Run `texra doctor --help` for usage.',
    );
  });

  it('keeps stdout clean when rejecting unknown flags in structured mode', async () => {
    const result = await runCli([
      'models',
      'list',
      '--unknown',
      '--no-input',
      '--output-format',
      'json',
    ]);
    expectUsageError(
      result,
      'Unknown option: --unknown. Run `texra models list --help` for usage.',
    );
  });

  it('preserves the interactive-command error for headless-only flags', async () => {
    const cases: Array<{ args: string[]; message: string; absent: string[] }> =
      [
        {
          args: ['chat', '--print'],
          message: 'texra chat is interactive and does not support --print.',
          absent: ['--output-format', '--no-input', 'Unknown option'],
        },
        {
          args: ['setup', '--no-input'],
          message:
            'texra setup is interactive and does not support --no-input.',
          absent: ['--print', '--output-format', 'Unknown option'],
        },
        {
          args: ['setup', '--no-input=true'],
          message:
            'texra setup is interactive and does not support --no-input.',
          absent: ['--print', '--output-format', 'Unknown option'],
        },
      ];

    for (const { args, message, absent } of cases) {
      stderr = '';

      const result = await runCli(args);

      expectUsageError(result, message);
      for (const text of absent) {
        expect(stderr).not.toContain(text);
      }
    }
  });

  it('rejects camelCase headless-only flags on interactive commands', async () => {
    const result = await runCli(['chat', '--outputFormat', 'json']);
    expectUsageError(
      result,
      'Unknown option: --outputFormat. Run `texra chat --help` for usage.',
    );
  });

  it('documents interactive chat controls in chat --help', async () => {
    const result = await runCli(['chat', '--help']);
    expectOk(result);
    expect(stdout).toContain('INTERACTIVE CONTROLS');
    expect(stdout).toContain('/help');
    expect(stdout).toContain('/status');
    expect(stdout).toContain('/goal');
    expect(stdout).toContain(
      'explain autonomous goal mode and approved-plan startup',
    );
    expect(stdout).toContain('/login, /logout');
    expect(stdout).toContain('ChatGPT or Researcher Access');
    expect(stdout).toContain(
      "open the focused stream's full output in a scrollable reader (PgUp/PgDn pages)",
    );
    expect(stdout).toContain('Tab');
    expect(stdout).toContain('select a visible child session or process');
    expect(stdout).not.toContain('open tasks and sub-workflows');
    expect(stdout).not.toContain('open subagents when available');
    expect(stdout).toContain('Esc 1..9');
    expect(stdout).toContain('focus a visible stream');
    expect(stdout).toContain('approvals');
    expect(stdout).toContain('Ctrl-C');
  });

  it('documents launcher controls in orchestrate --help', async () => {
    const result = await runCli(['orchestrate', '--help']);
    expectOk(result);
    expect(stdout).toContain('INTERACTIVE CONTROLS');
    expect(stdout).toContain('↑/↓');
    expect(stdout).toContain('1-9/a-z');
    expect(stdout).toContain('open an item directly');
    expect(stdout).toContain('Enter');
    expect(stdout).toContain('Esc');
  });

  // Resume is dual-mode: a workflow run resumes headless, so the headless
  // globals are accepted and advertised alongside the interactive ones.
  it('advertises headless globals in resume --help', async () => {
    const result = await runCli(['resume', '--help']);
    expectOk(result);
    expect(stdout).toContain('USAGE texra resume');
    expect(stdout).toContain('--approval-policy');
    expect(stdout).toContain('--print');
    expect(stdout).toContain('--output-format');
    expect(stdout).toContain('--no-input');
  });

  it('accepts headless globals on resume instead of rejecting them', async () => {
    const result = await runCli(['resume', 'abc123', '--print']);
    expectUsageError(result, 'Execution not found: abc123');
    expect(stderr).not.toContain('is interactive');
    expect(stderr).not.toContain('Unknown option');

    stderr = '';
    const shortcutResult = await runCli([
      '--output-format',
      'json',
      '--resume',
      'abc123',
    ]);
    expectUsageError(shortcutResult, 'Execution not found: abc123');
    expect(stderr).not.toContain('is interactive');
    expect(stderr).not.toContain('Unknown option');
  });

  it('points setup users at the existing auth status command', async () => {
    const result = await runCli(['setup', '--help']);
    expectOk(result);
    expect(stdout).toContain('texra auth status');
    expect(stdout).not.toContain('texra status');
  });

  it('shows ChatGPT and Researcher examples in login help', async () => {
    let result = await runCli(['login', '--help']);
    expectOk(result);
    expect(stdout).toContain('EXAMPLES');
    expect(stdout).toContain('texra auth chatgpt login');
    expect(stdout).toContain('texra login');
    expect(stdout).toContain('Researcher Access');

    stdout = '';
    stderr = '';
    result = await runCli(['auth', 'login', '--help']);
    expectOk(result);
    expect(stdout).toContain('USAGE texra auth login');
    expect(stdout).toContain('texra auth chatgpt login');
    expect(stdout).toContain('texra login --device');
  });

  it('shows EXAMPLES and a docs link in root --help', async () => {
    const result = await runCli(['--help']);
    expectOk(result);
    expect(stdout).toContain('EXAMPLES');
    expect(stdout).toContain('texra auth chatgpt login');
    expect(stdout).toContain('texra login');
    expect(stdout).toContain('texra chat');
    expect(stdout).toContain('texra run <agent> --input file.tex');
    expect(stdout).toContain('texra agents list');
    expect(stdout).toContain('texra doctor');
    expect(stdout).toContain('Learn more: https://texra.ai');
  });

  it('honors --no-color in explicit help output', async () => {
    const result = await runCli(['--no-color', '--help']);
    expectOk(result);
    expect(stdout).toContain('USAGE');
    expect(stdout).toBe(stripAnsi(stdout));
  });

  it('honors --no-color in help command output', async () => {
    const result = await runCli(['--no-color', 'help']);
    expectOk(result);
    expect(stdout).toContain('USAGE');
    expect(stdout).toBe(stripAnsi(stdout));
  });

  it('prints version output when no-op global color flags are present', async () => {
    for (const args of [
      ['--version', '--no-color'],
      ['--no-color', 'version'],
      ['version', '--no-color'],
    ]) {
      stdout = '';
      stderr = '';

      const result = await runCli(args);

      expectOk(result);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('honors structured output for the version command', async () => {
    const jsonResult = await runCli(['version', '--output-format', 'json']);
    expectOk(jsonResult);
    expect(JSON.parse(stdout)).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });

    stdout = '';
    stderr = '';

    const ndjsonResult = await runCli([
      '--version',
      '--output-format',
      'ndjson',
    ]);
    expectOk(ndjsonResult);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      kind: 'version',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      ts: expect.any(String),
    });
  });

  it('prints version output without resolving workspace context', async () => {
    const result = await runCli([
      '--cwd',
      '/definitely/missing/texra-version-test',
      '--version',
      '--output-format',
      'json',
    ]);

    expectOk(result);
    expect(JSON.parse(stdout)).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });

  it('honors TEXRA_OUTPUT_FORMAT for version output without workspace context', async () => {
    const previousOutputFormat = process.env.TEXRA_OUTPUT_FORMAT;
    process.env.TEXRA_OUTPUT_FORMAT = 'ndjson';
    try {
      const result = await runCli([
        '--cwd',
        '/definitely/missing/texra-version-test',
        '--version',
      ]);

      expectOk(result);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        kind: 'version',
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        ts: expect.any(String),
      });
    } finally {
      if (previousOutputFormat === undefined) {
        delete process.env.TEXRA_OUTPUT_FORMAT;
      } else {
        process.env.TEXRA_OUTPUT_FORMAT = previousOutputFormat;
      }
    }
  });

  it('shows EXAMPLES and a docs link for bare `help`', async () => {
    const result = await runCli(['help']);
    expectOk(result);
    expect(stdout).toContain('EXAMPLES');
    expect(stdout).toContain('Learn more: https://texra.ai');
  });

  it('shows command-specific usage for help command paths', async () => {
    const result = await runCli(['help', 'chat']);
    expectOk(result);
    expect(stdout).toContain('Interactive tool-use chat session');
    expect(stdout).toContain('USAGE texra chat');
    expect(stdout).toContain('INTERACTIVE CONTROLS');
    expect(stdout).toContain('/goal');
    expect(stdout).toContain('select a visible child session or process');
    expect(stdout).not.toContain('open subagents when available');
    expect(stdout).toContain('Esc 1..9');
  });

  it('shows orchestrate controls for help command paths', async () => {
    const result = await runCli(['help', 'orchestrate']);
    expectOk(result);
    expect(stdout).toContain('Interactive launcher');
    expect(stdout).toContain('USAGE texra orchestrate');
    expect(stdout).toContain('INTERACTIVE CONTROLS');
    expect(stdout).toContain('1-9/a-z');
    expect(stdout).toContain('open an item directly');
    expect(stdout).toContain('Esc');
  });

  it('shows nested command-specific usage for help command paths', async () => {
    const result = await runCli(['help', 'multi-agent', 'run']);
    expectOk(result);
    expect(stdout).toContain('Run a multi-agent team preset');
    expect(stdout).toContain('USAGE texra multi-agent run');
    expect(stdout).toContain(
      'Root agent for the team run (defaults to the preset orchestrator)',
    );
    expect(stdout).toContain('Model for the team root agent');
    expect(stdout).toContain('RUN MODE');
    expect(stdout).toContain(
      'executes the team in the terminal and exits after the final response',
    );
    expect(stdout).toContain('use `texra orchestrate`');
    expect(stdout).not.toContain('root tool-use agent');
  });

  it('shows full command paths for nested --help usage', async () => {
    const result = await runCli(['history', 'show', '--help']);
    expectOk(result);
    expect(stdout).toContain('Show one stored execution');
    expect(stdout).toContain('USAGE texra history show');
    expect(stdout).toContain('Show the full stored conversation');
  });

  it('shows full command paths for nested usage errors', async () => {
    const result = await runCli(['history', 'show']);
    expectUsageError(result, 'USAGE texra history show');
  });

  it('defaults bare history to list while accepting global flags', async () => {
    await withTempDir('texra-history-', async (root) => {
      const result = await runCli([
        'history',
        '--cwd',
        root,
        '--output-format',
        'json',
      ]);

      expectOk(result);
      expect(JSON.parse(stdout)).toEqual([]);
    });
  });

  it('forwards history globals before an explicit subcommand', async () => {
    const missingRoot = path.join(
      os.tmpdir(),
      `texra-history-missing-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
    );

    const result = await runCli([
      'history',
      '--cwd',
      missingRoot,
      'list',
      '--output-format',
      'json',
    ]);

    expectUsageError(result, `--cwd: path does not exist: ${missingRoot}`);
  });

  it('shows the history parent default and global flags in help', async () => {
    const result = await runCli(['history', '--help']);

    expectOk(result);
    expect(stdout).toContain('USAGE texra history');
    expect(stdout).toContain('--output-format=<text|json|ndjson>');
    expect(stdout).toContain('list');
  });

  it('accepts the documented multi-agent show command', async () => {
    const result = await runCli(['multi-agent', 'show', 'mathematician']);
    expectOk(result);
    expect(stdout).toContain('Mathematician (mathematician)');
    expect(stdout).toContain('Team root agent:');
    expect(stdout).toContain('Available workflow agents:');
    expect(stdout).toContain('Missing tool-use agents:');
  });

  it('prints recovery hints for unknown multi-agent presets', async () => {
    const commands = [
      ['multi-agent', 'show', 'does-not-exist'],
      [
        'multi-agent',
        'run',
        'does-not-exist',
        '--instruction',
        'Check this derivation.',
      ],
    ];

    for (const command of commands) {
      stderr = '';
      stdout = '';

      const result = await runCli(command);

      expect(result.exitCode).toBe(2);
      expect(stripAnsi(stderr)).toContain(
        'Multi-agent preset not found: does-not-exist. Use `texra multi-agent list` for available team presets, then run `texra multi-agent show <preset>` to check a team before launch.',
      );
      expect(stdout).toBe('');
    }
  });

  it('reports unknown command paths passed to help', async () => {
    const result = await runCli(['help', 'bogus']);
    expectUsageError(result, 'Unknown command: texra bogus');
  });
});

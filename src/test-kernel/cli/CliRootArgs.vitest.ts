import '@test/support/defaultSessionTestSetup';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { rootCommand, runCli } from '@cli/commands/root';
import {
  normalizeRootShortcuts,
  reorderGlobalFlags,
  detectUnknownCliCommand,
  detectUnknownCliFlag,
} from '@cli/commands/_helpers/dispatch';
import {
  collectStringFlagValues,
  pickGlobalArgs,
} from '@cli/commands/_helpers/globalArgs';
import { expandRunInputs } from '@cli/runtime/workflowInputs';
import {
  resolveWorkflowOutput,
  resumeWorkflowOutputFile,
} from '@cli/runtime/workflowOutput';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import {
  makeTempDir,
  useTempDirs,
  withTempDirEffect,
} from '@test/support/tempDirPlatform';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';

type StoredResumeConfig = Parameters<typeof resumeWorkflowOutputFile>[0];

function storedConfig(
  overrides: Partial<StoredResumeConfig> = {},
): StoredResumeConfig {
  return {
    ...asDocumentTask({
      agent: 'polish',
      model: 'deepseek/deepseek-v4-flash',
      inputFiles: ['paper.tex'],
      contextFiles: [],
      outputFiles: [],
      instruction: undefined,
      workingDirectory: '/tmp/project',
    }),
    ...overrides,
  };
}

async function initNodeBackedPlatform(options: {
  storagePath: string;
  globalStoragePath: string;
}): Promise<void> {
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform({
    workspacePath: process.cwd(),
    storagePath: options.storagePath,
    globalStoragePath: options.globalStoragePath,
  });
  await Effect.runPromise(
    openTestDefaultSession({ roots: testWorkspaceRoots() }),
  );
}

async function initDefaultFakePlatform(): Promise<void> {
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform();
}

const withExternalDirs = <A, E, R>(
  run: (root: string, externalDir: string) => Effect.Effect<A, E, R>,
) =>
  withTempDirEffect('texra-cli-inputs-', (root) =>
    withTempDirEffect('texra-cli-external-', (externalDir) =>
      run(root, externalDir),
    ),
  );

const STDIN_DOCUMENT =
  '\\documentclass{article}\\begin{document}Hi\\end{document}';

function trackedStdinReader(body: string = STDIN_DOCUMENT): {
  readStdinText: Effect.Effect<string>;
  readCount: () => number;
} {
  let reads = 0;
  return {
    readStdinText: Effect.sync(() => {
      reads += 1;
      return body;
    }),
    readCount: () => reads,
  };
}

/**
 * Single-list expansion for one flag, over the public `expandRunInputs` entry
 * point. `--context` expansion allows an empty `--input` list so a
 * context-only case reaches the context stage.
 */
const expandSpecs = (
  specs: readonly string[],
  cwd: string,
  flagLabel: '--input' | '--context' = '--input',
  options: {
    readonly requireWorkspaceFiles?: boolean;
    readonly readStdinText?: Effect.Effect<string>;
  } = {},
) =>
  Effect.gen(function* () {
    if (flagLabel === '--context') {
      const { contextFiles } = yield* expandRunInputs([], specs, cwd, {
        ...options,
        allowEmptyInput: true,
      });
      return contextFiles;
    }
    const { inputFiles } = yield* expandRunInputs(specs, [], cwd, options);
    return inputFiles;
  }).pipe(Effect.provide(nodePlatformLayer));

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

  it('preserves global flags when routing top-level --resume', () => {
    expect(
      normalizeRootShortcuts(['--output-format', 'json', '--resume', 'abc123']),
    ).toEqual(['resume', 'abc123', '--output-format', 'json']);
  });

  it('keeps leading global flags attached to explicit subcommands', () => {
    expect(reorderGlobalFlags(['--output-format', 'json', 'auth'])).toEqual([
      'auth',
      '--output-format',
      'json',
    ]);
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

  it('detects unknown command-scoped flags before command run', async () => {
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
      ['run', 'polish', '-mdeepseek/deepseek-v4-flash', '--no-color'],
      ['setup', '--no-input'],
      ['resume', 'abc123', '--print'],
      ['team', 'run', 'mathematician', '--instruction-file=prompt.md'],
      ['run', 'polish', '--input', 'paper.tex', '--instruction-file=prompt.md'],
    ]) {
      await expect(
        detectUnknownCliFlag(rootCommand, args),
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

  it.effect(
    'expands workflow input directories and globs relative to cwd',
    () =>
      withTempDirEffect('texra-cli-inputs-', (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.mkdir(path.join(root, 'paper', 'sections'), {
              recursive: true,
            }),
          );
          yield* Effect.promise(() =>
            fs.writeFile(path.join(root, 'paper', 'Draft0.tex'), 'draft'),
          );
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(root, 'paper', 'sections', 'appendix.tex'),
              'appendix',
            ),
          );
          yield* Effect.promise(() =>
            fs.writeFile(path.join(root, 'paper', 'notes.md'), 'notes'),
          );

          expect(yield* expandSpecs(['paper'], root)).toEqual([
            'paper/Draft0.tex',
            'paper/sections/appendix.tex',
          ]);
          expect(yield* expandSpecs(['paper/**/*.tex'], root)).toEqual([
            'paper/Draft0.tex',
            'paper/sections/appendix.tex',
          ]);
          expect(
            yield* expandSpecs(
              [path.join(root, 'paper', 'sections', 'appendix.tex')],
              root,
            ),
          ).toEqual(['paper/sections/appendix.tex']);
        }),
      ),
  );

  it.effect('materializes stdin when --input - is passed', () =>
    withTempDirEffect('texra-cli-stdin-', (root) =>
      Effect.gen(function* () {
        const { readStdinText, readCount } = trackedStdinReader(
          '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n',
        );

        const expanded = yield* Effect.scoped(
          Effect.gen(function* () {
            const files = yield* expandSpecs(['-', '-'], root, '--input', {
              readStdinText,
            });

            expect(files).toHaveLength(1);
            expect(readCount()).toBe(1);
            expect(path.basename(files[0])).toBe('stdin.tex');
            expect(path.basename(path.dirname(files[0]))).toMatch(
              /^texra-stdin-/,
            );
            yield* Effect.promise(() =>
              expect(
                fs.readFile(path.resolve(root, files[0]), 'utf8'),
              ).resolves.toContain('\\begin{document}Hi'),
            );
            return files;
          }),
        );

        // The scope above closes here, releasing the stdin temp file exactly
        // as the CLI run scope does when the run completes.
        yield* Effect.promise(() =>
          expect(fs.stat(path.resolve(root, expanded[0]))).rejects.toThrow(),
        );
        yield* Effect.promise(() =>
          expect(
            fs.stat(path.dirname(path.resolve(root, expanded[0]))),
          ).rejects.toThrow(),
        );
      }),
    ),
  );

  it.effect('does not read stdin before later --input validation errors', () =>
    withTempDirEffect('texra-cli-stdin-', (root) =>
      Effect.gen(function* () {
        const { readStdinText, readCount } = trackedStdinReader();

        const error = yield* Effect.flip(
          expandSpecs(['-', 'missing.tex'], root, '--input', {
            readStdinText,
          }),
        );
        expect(error.message).toMatch(/--input: file not found: missing\.tex/);
        expect(readCount()).toBe(0);
      }),
    ),
  );

  it.effect(
    'rejects external files when tool-use runs require workspace files',
    () =>
      withExternalDirs((root, externalDir) =>
        Effect.gen(function* () {
          const external = path.join(externalDir, 'problem.md');
          yield* Effect.promise(() => fs.writeFile(external, 'outside'));

          const error = yield* Effect.flip(
            expandRunInputs([external], [], root, {
              requireWorkspaceFiles: true,
            }).pipe(Effect.provide(nodePlatformLayer)),
          );
          expect(error.message).toMatch(/--input: file is outside --cwd:/);
        }),
      ),
  );

  it.effect('prefers an exact filename containing glob syntax', () =>
    withTempDirEffect('texra-cli-literal-magic-', (root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(root, 'refs')));
        yield* Effect.promise(() =>
          fs.writeFile(path.join(root, 'refs', '[ab].bib'), 'literal'),
        );
        yield* Effect.promise(() =>
          fs.writeFile(path.join(root, 'refs', 'a.bib'), 'glob match'),
        );

        expect(
          yield* expandSpecs([path.join('refs', '[ab].bib')], root),
        ).toEqual(['refs/[ab].bib']);
      }),
    ),
  );

  it.effect.skipIf(process.platform === 'win32')(
    'preserves POSIX glob escapes for literal metacharacters',
    () =>
      withTempDirEffect('texra-cli-escaped-glob-', (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(root, 'refs')));
          yield* Effect.promise(() =>
            fs.writeFile(path.join(root, 'refs', '[ab]-one.bib'), 'literal'),
          );
          yield* Effect.promise(() =>
            fs.writeFile(path.join(root, 'refs', 'a-one.bib'), 'class match'),
          );

          expect(
            yield* expandSpecs([String.raw`refs/\[ab]-*.bib`], root),
          ).toEqual(['refs/[ab]-one.bib']);
        }),
      ),
  );

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
          cli: { outputFile: '/tmp/elsewhere/paper.polished.tex' },
          outputFiles: ['paper.polished.tex'],
        }),
      ),
    ).toBe('/tmp/elsewhere/paper.polished.tex');
  });

  it('rejects relative stored CLI output targets', () => {
    expect(() =>
      resumeWorkflowOutputFile(
        storedConfig({
          cli: { outputFile: 'out/paper.polished.tex' },
          outputFiles: ['paper.polished.tex'],
        }),
      ),
    ).toThrow(
      'Stored document task output file is not absolute: out/paper.polished.tex',
    );
  });

  it.effect(
    'reports successful stopped workflows with missing requested outputs as failed copies',
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          resolveWorkflowOutput(
            'corrected.tex',
            undefined,
            {
              outcome: RUN_OUTCOME.COMPLETED,
              output: {
                response: '',
                files: [],
                structured: { outputs: [], compileFailures: [], diffs: [] },
              },
              runId: 'completed-without-output' as RunId,
            },
            createRunCommandCliContext(),
            { storageRoot: '/tmp/storage' },
          ).pipe(Effect.provide(nodePlatformLayer)),
        );

        expect(error).toEqual(
          new Error(
            'Document task completed without a generated output; corrected.tex was not written.',
          ),
        );
      }),
  );
});

describe('CLI global color/input flags', () => {
  it('maps CLI color and no-input flags to canonical knobs', () => {
    expect(
      pickGlobalArgs({ color: false, 'no-input': true }, []),
    ).toMatchObject({
      noColor: true,
      noInput: true,
    });
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
  const tempDirs = useTempDirs();
  let platformStorageRoot = '';

  beforeEach(async () => {
    platformStorageRoot = await makeTempDir('texra-cli-root-', tempDirs);
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
    const result = await runCli(['run', '--output-format', 'json']);
    expectUsageError(result, 'Missing required positional argument: AGENT');
    // The error leads, followed by a pointer to the usage rather than the
    // full help screen that used to bury it.
    expect(stderr).toMatch(
      /^Missing required positional argument: AGENT\nRun `texra run --help` for usage\.\n$/,
    );
  });

  it('prints explicit --help usage to stdout, not stderr', async () => {
    // Unix convention: an explicit `--help` request is normal output (STDOUT).
    // Only usage shown on an error is diagnostic (STDERR). This must not
    // regress when fixing the error path.
    const result = await runCli(['run', '--help']);
    expectOk(result);
    expect(stdout).toContain('USAGE');
  });

  it('rejects unknown flags before running command bodies', async () => {
    const result = await runCli(['doctor', '--bogus', '--no-input']);
    expectUsageError(
      result,
      'Unknown option: --bogus. Run `texra doctor --help` for usage.',
    );
  });

  // Resume is dual-mode: a workflow run resumes headless, so the headless
  // globals are accepted and advertised alongside the interactive ones.

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
});

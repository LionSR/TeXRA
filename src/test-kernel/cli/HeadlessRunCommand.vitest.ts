/**
 * `texra run` on a document task, driven through the CLI's entry
 * (`runCli`) in process: the CLI's own runtime and platform over a home of
 * the test's, with the validation model at the provider edge.
 *
 * Failure modes:
 * - a failed run's output is copied over the `--output` destination, its
 *   result names a copy, or the run storage it kept is lost.
 */
// Third-party imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { afterEach, assert, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { setLogSink } from '@texra-ai/harness/node';
import { CUSTOM_AGENTS_STORAGE_DIR } from '@common/storage/storageLayout';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { runCli } from '@cli/commands/root';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { REAL_RUN_TIMEOUT, validationHost } from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

/** A document task whose every model call the provider refuses as too long
 *  (`GOLDEN-OVERFLOW`), so the run fails. */
const FAILING_TASK = `name: overflow_polish
description: A document task the provider refuses every call of.
prompt: |-
  GOLDEN-OVERFLOW: refuse every call.
task:
  prefix: |
    <documents>
    {{ ALL_INPUTS }}
    </documents>
  requests:
    - Polish the document.
`;

const decodeRunDirectory = Schema.decodeUnknownSync(
  Schema.Struct({ runDirectory: Schema.String }),
);

/**
 * The CLI as a process of the test's: its home (and so its storage root)
 * is the host's temp dir, it reaches no background service, sends no usage
 * and holds a provider key, which the validation model answers for.
 */
const cliProcess = Effect.gen(function* () {
  const { workspace } = (yield* FakeHost).roots;
  assert(workspace !== undefined, 'the validation host opens a workspace');
  // Beside the host's workspace, so the host's release removes it.
  const home = path.join(path.dirname(workspace), 'home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('TEXRA_NO_SERVICE', '1');
  vi.stubEnv('TEXRA_NO_TELEMETRY', '1');
  vi.stubEnv('OPENAI_API_KEY', 'validation-fake-key');
  const agents = path.join(
    resolveGlobalStoragePath(path.join(home, '.texra')),
    CUSTOM_AGENTS_STORAGE_DIR,
  );
  yield* Effect.promise(async () => {
    await fs.mkdir(agents, { recursive: true });
    await fs.writeFile(path.join(agents, 'overflow_polish.yaml'), FAILING_TASK);
  });
  return { home, workspace };
});

describe('texra run, document tasks', { timeout: REAL_RUN_TIMEOUT }, () => {
  let stdout = '';
  let stderr = '';
  beforeEach(() => {
    stdout = '';
    stderr = '';
    spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
    spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // The CLI's platform silences the process's log sink: put it back.
    setLogSink(null);
  });

  // Live clock: the CLI's entry and its run work in real time.
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-workflow-'), { buildPerTest: true })(
      (it) => {
        it.effect(
          'keeps failed output in run storage and preserves the requested --output destination',
          () =>
            Effect.gen(function* () {
              const { home, workspace } = yield* cliProcess;
              const target = path.join(workspace, 'polished.tex');
              yield* Effect.promise(async () => {
                await fs.writeFile(
                  path.join(workspace, 'paper.tex'),
                  '\\section{A}\nText.\n',
                );
                await fs.writeFile(target, 'keep-me');
              });

              const { exitCode } = yield* Effect.promise(() =>
                runCli([
                  'run',
                  'overflow_polish',
                  '--input',
                  'paper.tex',
                  '--output',
                  'polished.tex',
                  '--cwd',
                  workspace,
                  '--model',
                  'openai/gpt-5.6-sol',
                  '--output-format',
                  'json',
                ]),
              );

              expect(exitCode).toBe(CliExitCode.AgentError);
              expect(
                yield* Effect.promise(() => fs.readFile(target, 'utf8')),
              ).toBe('keep-me');
              const result: unknown = JSON.parse(stdout);
              expect(result).toMatchObject({
                outcome: 'failed',
                output: { documents: { outputs: [] } },
              });
              expect(result).not.toHaveProperty('copiedOutput');
              expect(result).not.toHaveProperty('copiedOutputs');
              // The run's storage is kept, under the CLI's own storage root.
              const { runDirectory } = decodeRunDirectory(result);
              expect(runDirectory.startsWith(path.join(home, '.texra'))).toBe(
                true,
              );
              expect(
                (yield* Effect.promise(() =>
                  fs.stat(runDirectory),
                )).isDirectory(),
              ).toBe(true);
            }),
        );
      },
    );
  });
});

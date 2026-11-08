/**
 * `texra resume` of a one-shot `texra run`, over the CLI's own runtime and
 * platform in a home of the test's, with the validation model at the
 * provider edge.
 *
 * Failure modes:
 * - a one-shot run a crash cut off mid-turn (no outcome yet) is refused
 *   instead of reopening the chat to finish it;
 * - a one-shot run that ended reopens a chat that refuses every message,
 *   instead of a usage exit that points at `--fork`.
 */
// Third-party imports
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Fiber, Schedule, Schema } from 'effect';
import { afterEach, assert, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { setLogSink } from '@texra-ai/harness/node';
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { resolveWorkspaceStoragePath } from '@platform/defaults/workspaceStorage';
import { DocumentTaskOptionsSchema } from '@texra/shared/plugins/documents';
import { runCli } from '@cli/commands/root';
import { runHeadlessAgent } from '@cli/commands/run';
import { runResumeCommand } from '@cli/commands/resumeRun';
import { provideCliInvocation } from '@cli/runtime/platform/cliContext';
import { makeCliProcessRuntime } from '@cli/runtime/platform/cliProcessRuntime';
import { cliPlatform } from '@cli/runtime/platform/initPlatform';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import {
  BUNDLED_AGENTS,
  crashAt,
  crashedCopy,
  REAL_RUN_TIMEOUT,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

const MODEL = 'openai/gpt-5.6-sol';

const decodeRunId = Schema.decodeUnknownSync(
  Schema.Struct({ runId: RunIdSchema }),
);

/** A stored `model.message` row's kind. */
const decodePayloadKind = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ payload: Schema.Struct({ kind: Schema.String }) }),
  ),
);

/**
 * The CLI as a process of the test's: its home (and so its storage root)
 * is beside the host's workspace, it reaches no background service, sends
 * no usage and holds a provider key, which the validation model answers
 * for. Returns the context an interactive terminal in that workspace
 * builds, and the project's store.
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
  const storageRoot = path.join(home, '.texra');
  const context = createTestCliContext({
    cwd: workspace,
    storageRoot,
    resourcesPath: path.dirname(BUNDLED_AGENTS),
    mode: 'interactive',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
  });
  return {
    context,
    workspace,
    storage: resolveWorkspaceStoragePath(storageRoot, workspace),
  };
});

describe('texra resume', { timeout: REAL_RUN_TIMEOUT }, () => {
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

  // Live clock: the CLI's runtime and its runs work in real time.
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-resume-cli-'), { buildPerTest: true })(
      (it) => {
        it.effect(
          'reopens the chat TUI to finish an interrupted one-shot run',
          () =>
            Effect.gen(function* () {
              const { context, storage } = yield* cliProcess;
              // A headless `texra run` whose turn is held (`GOLDEN-PARK`
              // waits for a release file nobody writes).
              const first = makeCliProcessRuntime(context);
              // Disposed below; again here (a no-op then) if the case fails
              // before.
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => first.dispose()),
              );
              const ran = first.runFork(
                runHeadlessAgent(context, {
                  agent: 'assistant',
                  model: MODEL,
                  inputFiles: [],
                  contextFiles: [],
                  instruction: 'GOLDEN-PARK',
                  options: Schema.decodeUnknownSync(DocumentTaskOptionsSchema)(
                    {},
                  ),
                }).pipe(provideCliInvocation(context)),
              );
              // The project's store appears once the run's session opens,
              // and the model call is in flight once its attempt commits.
              yield* Effect.sync(() =>
                existsSync(path.join(storage, 'texra.db')),
              ).pipe(
                Effect.repeat({
                  until: Boolean,
                  schedule: Schedule.spaced('20 millis'),
                }),
                Effect.timeout('30 seconds'),
              );
              yield* untilStored(storage, (rows) =>
                rows.some(
                  (row) =>
                    row.type === 'model.message' &&
                    decodePayloadKind(row.data).payload.kind === 'attempt',
                ),
              );
              const held = storedRows(storage);
              const runId = Schema.decodeUnknownSync(RunIdSchema)(held[0]?.run);
              // The process is killed mid-turn: its store keeps what it had
              // committed then. Here it stops the run and exits, and the
              // store is then cut back to that commit.
              const killedAt = Math.max(...held.map((row) => row.commit));
              const { session } = yield* Effect.promise(() =>
                first.runPromise(cliPlatform),
              );
              yield* Effect.promise(() =>
                first.runPromise(
                  Effect.flatMap(session, (opened) =>
                    opened.request({
                      kind: 'run.stop',
                      runId,
                      reason: 'user',
                    }),
                  ),
                ),
              );
              yield* Fiber.join(ran);
              yield* Effect.promise(() => first.dispose());
              crashAt(
                path.join(crashedCopy(storage), 'texra.db'),
                storage,
                killedAt,
              );

              const second = makeCliProcessRuntime(context);
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => second.dispose()),
              );
              const outcome = yield* Effect.promise(() =>
                second.runPromise(
                  runResumeCommand(context, runId).pipe(
                    provideCliInvocation(context),
                  ),
                ),
              );
              expect(outcome).toMatchObject({
                chat: {
                  initialResume: {
                    id: runId,
                    config: { agent: 'assistant', model: MODEL },
                  },
                },
              });
            }),
        );

        it.effect(
          'does not reopen the chat for a run that takes no messages',
          () =>
            Effect.gen(function* () {
              const { workspace } = yield* cliProcess;
              // A headless `texra run` that ended: it ran once and reads no
              // input.
              const ran = yield* Effect.promise(() =>
                runCli([
                  'run',
                  'assistant',
                  '--instruction',
                  'Answer once.',
                  '--cwd',
                  workspace,
                  '--model',
                  MODEL,
                  '--output-format',
                  'json',
                ]),
              );
              expect(ran.exitCode).toBe(CliExitCode.Success);
              const { runId } = decodeRunId(JSON.parse(stdout));

              const resumed = yield* Effect.promise(() =>
                runCli(['resume', runId, '--cwd', workspace]),
              );
              expect(resumed.exitCode).toBe(CliExitCode.Usage);
              expect(stderr).toContain(`resume ${runId} --fork`);
            }),
        );
      },
    );
  });
});

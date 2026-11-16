/**
 * `executeCliConfig`, the headless run every CLI command starts, over a real
 * session on the validation model: the CLI's own host interactions attach,
 * and the platform's shutdown leaves the run as it stands.
 *
 * Failure modes:
 * - a headless run (no prompt can be answered) is offered an approval-gated
 *   tool, under the default policy or `ask`;
 * - a run the platform's shutdown cut gets a stop or an end written for it
 *   (it would read as stopped, not interrupted), the command exits as
 *   anything but an interruption (130), or leaves no resume hint.
 */
// Third-party imports
import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Layer, Schema, Scope } from 'effect';
import { afterEach, assert, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import type { AgentConfigPayload } from '@texra-ai/harness/schemas';
import { RunHistory } from '@shared/session/runHistory';
import {
  provideCliInvocation,
  type CliContext,
} from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { executeCliConfig } from '@cli/runtime/headless/executeCli';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import {
  REAL_RUN_TIMEOUT,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

const MODEL = 'openai/gpt-5.6-sol';

/** A stored `model.message` row's kind. */
const decodePayloadKind = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ payload: Schema.Struct({ kind: Schema.String }) }),
  ),
);

/** The CLI context of a headless run in the host's workspace. */
const headless = (overrides: Partial<CliContext> = {}) =>
  Effect.map(FakeHost, ({ roots }) =>
    createTestCliContext({ cwd: roots.workspace, ...overrides }),
  );

/** `config` run as `texra run` runs a tool-use agent, on the test's session
 *  and the host's shutdown scope. */
const runHeadless = (config: AgentConfigPayload, context: CliContext) =>
  Effect.gen(function* () {
    const session = yield* TestSession;
    return yield* executeCliConfig(config, context, {
      services: {
        session: Effect.succeed(session),
        shutdownScope: (yield* FakeHost).platform.shutdownScope,
      },
      recoveryInputIsDurable: true,
    }).pipe(provideCliInvocation(context));
  });

describe('executeCliConfig', { timeout: REAL_RUN_TIMEOUT }, () => {
  let stderr = '';
  beforeEach(() => {
    stderr = '';
    spyOnStreamWrite(process.stdout);
    spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Live clock: the run's model turns and the shutdown run in real time.
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(
      Layer.provideMerge(
        TestSession.layer(undefined, {
          persistent: true,
          answeredFromView: true,
        }),
        validationHost('texra-run-'),
      ),
      { buildPerTest: true },
    )((it) => {
      it.effect.each([
        { policy: 'never', overrides: {} },
        { policy: 'ask', overrides: { approvalPolicy: 'ask' } },
      ] as const)(
        'offers a headless $policy run no approval-gated tool',
        ({ overrides }) =>
          Effect.gen(function* () {
            // The persona declares `bash`, which asks for approval.
            const run = yield* runHeadless(
              { agent: 'golden_effect', model: MODEL, instruction: 'Go.' },
              yield* headless(overrides),
            );
            assert(run.ok, 'the run ended');
            const handle = yield* sessionHandleOf(yield* TestSession);
            const state = yield* Context.get(handle, RunHistory).load(
              run.result.runId,
            );
            const offered = state?.offeredTools?.map((tool) => tool.name);
            assert(offered !== undefined, 'the run was offered its tools');
            expect(offered).not.toContain('bash');
          }),
      );

      it.effect(
        'leaves a run the platform shutdown cut without a stop or an end and exits 130',
        () =>
          Effect.gen(function* () {
            const { platform, roots } = yield* FakeHost;
            // `GOLDEN-PARK` holds the turn on a release file nobody writes.
            const run = yield* Effect.forkChild(
              runHeadless(
                {
                  agent: 'golden_fork',
                  model: MODEL,
                  instruction: 'GOLDEN-PARK',
                },
                yield* headless(),
              ),
            );
            // The model call is in flight: its attempt is committed.
            yield* untilStored(roots.storage, (rows) =>
              rows.some(
                (row) =>
                  row.type === 'model.message' &&
                  decodePayloadKind(row.data).payload.kind === 'attempt',
              ),
            );
            yield* Scope.close(platform.shutdownScope, Exit.void);

            const ended = yield* Fiber.join(run);
            expect(ended).toEqual({
              ok: false,
              exitCode: CliExitCode.Interrupted,
            });
            const rows = storedRows(roots.storage);
            const runId = rows.find((row) => row.type === 'run.start')?.run;
            assert(runId !== undefined, 'the run registered');
            expect(
              rows
                .filter((row) => row.run === runId)
                .map((row) => row.type)
                .filter((type) => type === 'run.stop' || type === 'run.end'),
            ).toEqual([]);
            expect(stderr).toContain(`texra resume ${runId}`);
          }),
      );
    });
  });
});

import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';

import { beforeEach, expect, vi } from 'vitest';

import {
  type AgentConfig,
  AgentConfigSchema,
  qualifyAggregateId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { SessionLog, RunHistory } from '@shared/session/runHistory';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { seedRunRecord as commitRunRecord } from '@test/support/runRecordSeeds';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  writeTextStderr: vi.fn(),
}));

// `texra resume` reopens the chat TUI for tool-use sessions, so it must never
// pass `installSignalHandlers: false` — that leaves the TUI as the sole
// SIGINT/SIGTERM owner once it mounts (see initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/logSinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/logSinks')>()),
  writeTextStderr: mocks.writeTextStderr,
}));

const RUN_ID = 'eec001' as RunId;

const TOOL_USE_CONFIG = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'planner',
  model: 'gpt-5',
});

/** Seed the real (fake-platform-backed) run records and run aggregate into
 *  the test's session, which the command resolves off the services the
 *  init returns; the seeded session's handle comes back. */
const seedRunRecord = (config: AgentConfig | null) =>
  Effect.gen(function* () {
    const session = yield* TestSession;
    const handle = yield* sessionHandleOf(session);
    // `runResumeCommand` reads the session off the services the init returns.
    mocks.initCliPlatform.mockReturnValue(
      Effect.succeed({
        runtime: yield* SessionGraph.runtime,
        session: Effect.succeed(session),
      }),
    );
    yield* Context.get(handle, SessionLog).transact([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', RUN_ID),
        identity: { kind: 'agent', agent: 'planner' },
        userFollowUpSupport: 'unsupported',
        parent: null,
        provenance: null,
      },
    ]);
    if (config) yield* commitRunRecord(handle, RUN_ID, config);
    // The position that opens the run: its rows hold a checkpoint.
    const cell = yield* Context.get(handle, RunHistory).open(RUN_ID, {
      activation: () => Effect.succeed([]),
    });
    yield* cell.append([
      {
        type: 'run.position',
        aggregateId: qualifyAggregateId('run', RUN_ID),
        payload: { family: 'toolUse', at: 'turn.ready', turn: 0 },
      },
    ]);
    // Seeding wrote the run's rows, which claimed its aggregate. A run waiting
    // to be resumed is one nobody holds, so the seed gives the claim back: a
    // hold taken and let go releases it.
    yield* Effect.scoped(
      Context.get(handle, SessionLog).hold(RUN_ID, { ends: true }),
    );
    return handle;
  });

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    mode: 'interactive',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    ...overrides,
  });
}

/** The command's program, run the way `defineCliCommand` runs it. */
const run = (context: CliContext, id: RunId = RUN_ID) =>
  Effect.flatMap(
    Effect.promise(() => import('@cli/commands/resumeRun')),
    ({ runResumeCommand }) => runResumeCommand(context, id),
  );

// Live clock: the command runs as its entry runs it.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'runResumeCommand',
  (it) => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    // A session of its own per case, seeded by the case.
    it.layer(TestSession.layer(), { buildPerTest: true })((it) => {
      it.effect(
        'reopens the chat TUI with the persisted tool-use run record',
        () =>
          Effect.gen(function* () {
            yield* seedRunRecord(TOOL_USE_CONFIG);
            expect(yield* run(cliContext())).toEqual({
              chat: { initialResume: { id: RUN_ID, config: TOOL_USE_CONFIG } },
            });
          }),
      );

      it.effect(
        'rejects tool-use resume when the context says stdout is not a TTY',
        () =>
          Effect.gen(function* () {
            yield* seedRunRecord(TOOL_USE_CONFIG);
            expect(yield* run(cliContext({ stdoutIsTty: false }))).toBe(2);

            expect(mocks.writeTextStderr).toHaveBeenCalledWith(
              expect.stringContaining('For scripting, use `texra run`.'),
            );
          }),
      );

      it.effect(
        'refuses a run another live TeXRA process holds, naming its pid',
        () =>
          Effect.gen(function* () {
            const seededSession = yield* seedRunRecord(TOOL_USE_CONFIG);
            const log = Context.get(seededSession, SessionLog);
            vi.spyOn(log, 'owner').mockReturnValue(
              Effect.succeed({
                ownerId: JSON.stringify(['other-host', 4321, 'start-1']),
                liveness: 'alive',
              }),
            );

            expect(yield* run(cliContext())).toBe(CliExitCode.Usage);

            expect(mocks.writeTextStderr).toHaveBeenCalledWith(
              `Task ${RUN_ID} is held by another TeXRA process (pid 4321 on other-host).`,
            );
          }),
      );
    });
  },
);

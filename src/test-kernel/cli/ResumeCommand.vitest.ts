import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';

import { beforeEach, expect, vi } from 'vitest';

import {
  type AgentConfig,
  AgentConfigSchema,
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import { type CliContext } from '@cli/runtime/cliContext';
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
// The platform links the service a conversation continues in; none here.
vi.mock('@cli/runtime/cliService', () => ({
  isLinked: (link: { readonly none?: string }) => !('none' in link),
}));

vi.mock('@cli/runtime/logSinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/logSinks')>()),
  writeTextStderr: mocks.writeTextStderr,
}));

const RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('eec001');

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
        runSession: Effect.succeed(session),
        service: { none: 'no service in this test' },
      }),
    );
    yield* Context.get(handle, SessionLog).transact([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', RUN_ID),
        identity: { kind: 'agent', agent: 'planner' },
        takesFollowUps: false,
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
    });
  },
);

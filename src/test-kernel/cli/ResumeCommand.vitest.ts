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
import {
  provideCliInvocation,
  type CliContext,
} from '@cli/runtime/platform/cliContext';
import {
  CliPlatform,
  type CliPlatformServices,
} from '@cli/runtime/platform/initPlatform';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import type { Session } from '@texra-ai/harness';
import { SessionLog, RunHistory } from '@shared/session/runHistory';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { seedRunRecord as commitRunRecord } from '@test/support/runRecordSeeds';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

const mocks = vi.hoisted(() => ({
  writeTextStderr: vi.fn(),
}));

// The platform links the service a conversation continues in; none here.
vi.mock('@cli/runtime/platform/cliService', () => ({
  isLinked: (link: { readonly none?: string }) => !('none' in link),
}));

vi.mock('@cli/runtime/platform/logSinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/platform/logSinks')>()),
  writeTextStderr: mocks.writeTextStderr,
}));

const RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('eec001');

const TOOL_USE_CONFIG = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'planner',
  model: 'gpt-5',
});

/** Seed the real (fake-platform-backed) run records and run aggregate into
 *  the test's session, which the command resolves off its platform; the
 *  seeded session's handle comes back. */
const seedRunRecord = (config: AgentConfig | null, takesFollowUps = true) =>
  Effect.gen(function* () {
    const handle = yield* sessionHandleOf(yield* TestSession);
    yield* Context.get(handle, SessionLog).transact([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', RUN_ID),
        identity: { kind: 'agent', agent: 'planner' },
        takesFollowUps,
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

/** The command's program, run the way `defineCliCommand` runs it, over a
 *  platform that is the test's session and links no service. A `session`
 *  given stands in for the test's (a service window's, say). */
const run = (context: CliContext, id: RunId = RUN_ID, given?: Session) =>
  Effect.gen(function* () {
    const session = given ?? (yield* TestSession);
    const { runResumeCommand } = yield* Effect.promise(
      () => import('@cli/commands/resumeRun'),
    );
    // cast: the command reads only these members of its platform.
    const platform = {
      runtime: yield* SessionGraph.runtime,
      session: Effect.succeed(session),
      runSession: Effect.succeed(session),
      service: { none: 'no service in this test' },
    } as unknown as CliPlatformServices;
    return yield* runResumeCommand(context, id).pipe(
      provideCliInvocation(context),
      Effect.provideService(CliPlatform, Effect.succeed(platform)),
    );
  });

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
        'does not reopen the chat for a run that takes no messages',
        () =>
          Effect.gen(function* () {
            // A service window's view fills after it opens, so the one the
            // command first sees lacks the run its log already holds.
            const session = yield* TestSession;
            const opened = session.view.current();
            // A headless `texra run` root: it ran once and reads no input.
            yield* seedRunRecord(TOOL_USE_CONFIG, false);
            const lagging: Session = {
              ...session,
              view: { ...session.view, current: () => opened },
            };
            expect(yield* run(cliContext(), RUN_ID, lagging)).toBe(
              CliExitCode.Usage,
            );
            expect(mocks.writeTextStderr).toHaveBeenCalledWith(
              expect.stringContaining(`resume ${RUN_ID} --fork`),
            );
          }),
      );
    });
  },
);

import '@test/support/sessionGraphTestSetup';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import {
  aggregateId,
  emptyRunEndOutput,
  storedRunOutput,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { seedRunRecord as commitRunRecord } from '@test/support/runRecordSeeds';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';

const mocks = vi.hoisted(() => ({
  assertOutputDirAvailable: vi.fn(),
  assertOutputFileAvailable: vi.fn(),
  executeCliWorkflowConfig: vi.fn(),
  initCliPlatform: vi.fn(),
  resolveCliRunAgent: vi.fn(),
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

vi.mock('@cli/runtime/agents', () => ({
  resolveCliRunAgent: mocks.resolveCliRunAgent,
}));

vi.mock('@cli/commands/workflow', () => ({
  executeCliWorkflowConfig: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.executeCliWorkflowConfig(...args),
      catch: (error) => error,
    }),
}));

vi.mock('@cli/runtime/workflowOutput', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/workflowOutput')>()),
  assertOutputDirAvailable: mocks.assertOutputDirAvailable,
  assertOutputFileAvailable: mocks.assertOutputFileAvailable,
}));

const RUN_ID = 'eec001' as RunId;

const TOOL_USE_CONFIG = AgentConfigSchema.parse({
  agent: 'planner',
  model: 'gpt-5',
});

const WORKFLOW_CONFIG = AgentConfigSchema.parse(
  documentTaskConfig({
    agent: 'correct',
    model: 'google/gemini-3.1-pro-preview',
  }),
);

/** The session the seeded run lives in, as the command resolves it. */
let seededSession: SessionHandle;

/** Seed the real (fake-platform-backed) run records and run aggregate. */
async function seedRunRecord(seed: {
  readonly config?: AgentConfig | null;
  readonly checkpoint?: boolean;
}): Promise<void> {
  const session = await Effect.runPromise(createProcessSession());
  seededSession = session;
  // `runResumeCommand` reads the session off the services the init returns.
  mocks.initCliPlatform.mockReturnValue(
    Effect.succeed({
      runtime: testRuntime(),
      session: Effect.succeed(session),
    }),
  );
  await Effect.runPromise(
    session.log.transact([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', RUN_ID),
        identity: { kind: 'agent', agent: seed.config?.agent ?? 'planner' },
        userFollowUpSupport: 'unsupported',
        parent: null,
        provenance: null,
      },
    ]),
  );
  if (seed.config)
    await Effect.runPromise(commitRunRecord(session, RUN_ID, seed.config));
  if (seed.checkpoint !== false) {
    // The position that opens the run: its rows hold a checkpoint.
    await Effect.runPromise(session.runHistory.acquire(RUN_ID));
    await Effect.runPromise(
      session.runHistory.appendBatch(RUN_ID, null, [
        {
          type: 'run.position',
          aggregateId: aggregateId('run', RUN_ID),
          payload: { family: 'toolUse', at: 'turn.ready', turn: 0 },
        },
      ]),
    );
  }
  // Seeding wrote the run's rows, which claimed its aggregate. A run waiting
  // to be resumed is one nobody holds, so the seed gives the claim back: a
  // hold taken and let go releases it.
  await Effect.runPromise(
    Effect.scoped(session.log.hold(RUN_ID, { ends: true })),
  );
}

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
async function run(context: CliContext, id: RunId = RUN_ID) {
  const { runResumeCommand } = await import('@cli/commands/resumeRun');
  return testRuntime().runPromise(runResumeCommand(context, id));
}

/** Seed a workflow run the real retrieval resumes. */
async function seedWorkflowResume(config: AgentConfig): Promise<void> {
  await seedRunRecord({ config });
}

describe('runResumeCommand', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedRunRecord({ config: TOOL_USE_CONFIG });
    mocks.resolveCliRunAgent.mockReturnValue(
      Effect.succeed({
        name: 'correct',
      }),
    );
    mocks.executeCliWorkflowConfig.mockResolvedValue(0);
    mocks.assertOutputDirAvailable.mockReturnValue(Effect.void);
    mocks.assertOutputFileAvailable.mockReturnValue(Effect.void);
  });

  it('reopens the chat TUI with the persisted tool-use run record', async () => {
    await expect(run(cliContext())).resolves.toEqual({
      chat: { initialResume: { id: RUN_ID, config: TOOL_USE_CONFIG } },
    });

    expect(mocks.executeCliWorkflowConfig).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('leaves the platform signal handler installed for the TUI to take over', async () => {
    const context = cliContext();

    await run(context);

    expect(mocks.initCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining(context),
    );
    expect(mocks.initCliPlatform.mock.calls[0]?.[0]).not.toHaveProperty(
      'installSignalHandlers',
    );
  });

  it('resumes a workflow run headless under its persisted run id', async () => {
    await seedRunRecord({ config: WORKFLOW_CONFIG });

    // Headless (non-TTY) is fine for the workflow arm — only tool-use resume
    // needs an interactive terminal.
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      WORKFLOW_CONFIG,
      expect.any(Object),
      expect.objectContaining({ runId: RUN_ID }),
    );
    expect(mocks.resolveCliRunAgent).toHaveBeenCalledWith(
      expect.anything(),
      'correct',
    );
  });

  it('restores an absolute persisted workflow output directory', async () => {
    const workingDirectory = path.join(path.sep, 'tmp', 'paper ');
    const outputDirectory = path.join(workingDirectory, 'out');
    const workflowConfig = AgentConfigSchema.parse({
      ...WORKFLOW_CONFIG,
      workingDirectory,
      cli: {
        outputDirectory,
        expectedOutputFiles: ['paper.tex', 'appendix.tex'],
      },
    });
    await seedWorkflowResume(workflowConfig);

    await expect(run(cliContext())).resolves.toBe(0);

    expect(mocks.assertOutputDirAvailable).toHaveBeenCalledWith(
      outputDirectory,
      expect.any(String),
    );
    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      workflowConfig,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('validates a restored output directory before resuming the workflow', async () => {
    const workingDirectory = path.join(path.sep, 'tmp', 'paper');
    const workflowConfig = AgentConfigSchema.parse({
      ...WORKFLOW_CONFIG,
      workingDirectory,
      cli: { outputDirectory: path.join(workingDirectory, 'out') },
    });
    await seedWorkflowResume(workflowConfig);
    mocks.assertOutputDirAvailable.mockReturnValue(
      Effect.fail(new CliUsageError('--output-dir must refer to a directory.')),
    );

    await expect(run(cliContext())).resolves.toBe(CliExitCode.Usage);

    expect(mocks.assertOutputFileAvailable).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
    );
    expect(mocks.assertOutputDirAvailable).toHaveBeenCalledWith(
      path.join(path.sep, 'tmp', 'paper', 'out'),
      expect.any(String),
    );
    expect(mocks.executeCliWorkflowConfig).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
      '--output-dir must refer to a directory.',
    );
  });

  it('rejects tool-use resume when the context says stdout is not a TTY', async () => {
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra resume ${RUN_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra run`.'),
    );
  });

  it('rejects tool-use resume in dumb terminals before falling through to chat', async () => {
    await expect(run(cliContext({ termIsDumb: true }))).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'texra resume needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`. For non-interactive runs, use `texra run`.',
    );
  });

  it('reports an unknown run id as a usage error', async () => {
    await seedRunRecord({ config: null });

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Run not found: ${RUN_ID}`,
    );
  });

  it.effect('reports an ended run with no checkpoint as finished', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        seedRunRecord({ config: TOOL_USE_CONFIG, checkpoint: false }),
      );
      // Registered and never opened, it would resume by opening: it ended.
      yield* Effect.scoped(
        seededSession.log.hold(RUN_ID).pipe(
          Effect.andThen(
            seededSession.log.transact([
              {
                type: 'run.end',
                aggregateId: aggregateId('run', RUN_ID),
                outcome: 'failed',
                output: storedRunOutput(emptyRunEndOutput()),
              },
            ]),
          ),
        ),
      );

      expect(yield* Effect.promise(() => run(cliContext()))).toBe(2);

      expect(mocks.writeTextStderr).toHaveBeenCalledWith(
        'This run has finished. Start a new agent task to continue.',
      );
    }),
  );

  it('refuses a run another live TeXRA process holds, naming its pid', async () => {
    vi.spyOn(seededSession.log, 'owner').mockReturnValue(
      Effect.succeed({
        ownerId: JSON.stringify(['other-host', 4321, 'start-1']),
        liveness: 'alive',
      }),
    );

    await expect(run(cliContext())).resolves.toBe(CliExitCode.Usage);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Task ${RUN_ID} is held by another TeXRA process (pid 4321 on other-host).`,
    );
  });

  it('identifies claim read failures separately from session loading', async () => {
    vi.spyOn(seededSession.log, 'owner').mockReturnValue(
      Effect.fail(
        new DatabaseReadFailed({
          path: 'session.db',
          cause: new Error('claim disk offline'),
        }),
      ),
    );

    // An unreadable claim fails the command with the read's own error,
    // never a refusal that would tell the user to delete the run.
    await expect(run(cliContext())).rejects.toMatchObject({
      _tag: 'DatabaseReadFailed',
    });
  });

  // One reader now: the classification and the resume both read the run's
  // latest snapshot. The guarantee that survives the collapse is the negative
  // one — a run whose aggregate still carries a snapshot is never reported to
  // its user as finished; the real retrieval resumes it.
  it('never reports a run that still has a snapshot as finished', async () => {
    await seedWorkflowResume(WORKFLOW_CONFIG);

    await expect(run(cliContext())).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalled();
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('This run has finished'),
    );
  });
});

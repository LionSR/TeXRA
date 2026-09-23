import '@test/support/sessionGraphTestSetup';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { getRunRecords } from '@agent/storage/runRecords';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { aggregateId } from '@shared/schemas';
import type { FlowSnapshotPayload, RunId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  assertOutputDirAvailable: vi.fn(),
  assertOutputFileAvailable: vi.fn(),
  executeCliWorkflowConfig: vi.fn(),
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
  resolveCliLaunchAgent: vi.fn(),
  runChat: vi.fn(),
  writeTextStderr: vi.fn(),
}));

// `texra resume` reopens the chat TUI for tool-use sessions, so it must never
// pass `installSignalHandlers: false` — that leaves the TUI as the sole
// SIGINT/SIGTERM owner once it mounts (see initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', () => ({
  installCliProcessRuntime: mocks.installCliProcessRuntime,
  disposeCliProcessRuntime: Effect.void,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/runtime/agents', () => ({
  resolveCliLaunchAgent: mocks.resolveCliLaunchAgent,
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

vi.mock('@cli/chat/tui/runChatTui', () => ({
  runChat: mocks.runChat,
}));

const RUN_ID = 'eec001' as RunId;

const TOOL_USE_CONFIG = AgentConfigSchema.parse({
  agent: 'planner',
  model: 'gpt-5',
  agentCategory: AgentCategory.ToolUse,
});

const WORKFLOW_CONFIG = AgentConfigSchema.parse({
  agent: 'correct',
  model: 'gemini31p',
  agentCategory: AgentCategory.Workflow,
});

/** The opening snapshot of a tool-use run, as the loop's first batch writes it. */
const OPENING_SNAPSHOT: FlowSnapshotPayload = {
  family: 'toolUse',
  runtime: {
    phase: 'initial',
    round: 0,
    turn: 0,
    continuationIndex: 0,
    modelId: 'gpt54',
    modelCompatibilityKey: null,
    lastError: null,
    declinedRoutes: [],
  },
  state: { shouldSkipCycle: false, stateSlices: null },
};

/**
 * The checkpoint a workflow run's aggregate carries. The real
 * `retrieveSessionResumeData` reads it: the family must match the config's
 * category, and the runtime's model fields are what the resumed launch pins.
 */
const workflowSnapshot = (
  modelId: string,
  modelCompatibilityKey: FlowSnapshotPayload['runtime']['modelCompatibilityKey'] = null,
): FlowSnapshotPayload => ({
  family: 'reflection',
  runtime: {
    phase: 'initial',
    round: 0,
    turn: 0,
    continuationIndex: 0,
    modelId,
    modelCompatibilityKey,
    lastError: null,
    declinedRoutes: [],
  },
  state: {
    currentRound: 0,
    totalRounds: 4,
    workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
    outputLocation: null,
    runStateSnapshot: { totalRounds: 4, totalResponseTimeMs: 0 },
    continueRounds: true,
    endTurn: false,
  },
});

/** The session the seeded run lives in, as the command resolves it. */
let seededSession: SessionHandle;

/** Seed the real (fake-platform-backed) run records and run aggregate. */
async function seedRunRecord(seed: {
  readonly config?: AgentConfig | null;
  readonly checkpoint?: boolean;
  readonly modelCompatibilityKey?: FlowSnapshotPayload['runtime']['modelCompatibilityKey'];
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
  mocks.installCliProcessRuntime.mockImplementation(async () => testRuntime());
  await Effect.runPromise(
    session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', RUN_ID),
        identity: { kind: 'agent', agent: seed.config?.agent ?? 'planner' },
        category: seed.config?.agentCategory ?? AgentCategory.ToolUse,
        userFollowUpSupport: 'unsupported',
        isRemote: false,
        parent: null,
      },
    ]),
  );
  if (seed.config)
    await Effect.runPromise(
      getRunRecords(session, RUN_ID).writeRunRecord(seed.config),
    );
  if (seed.checkpoint !== false) {
    // The snapshot's family matches the seeded category: the real retrieval
    // refuses a contradiction, so the seed must be one a run could write.
    const snapshot =
      seed.config?.agentCategory === AgentCategory.Workflow
        ? workflowSnapshot(seed.config.model, seed.modelCompatibilityKey)
        : OPENING_SNAPSHOT;
    await Effect.runPromise(session.ledger.acquire(RUN_ID));
    await Effect.runPromise(
      session.ledger.appendBatch(RUN_ID, null, [
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', RUN_ID),
          payload: snapshot,
        },
      ]),
    );
  }
  // Seeding wrote the run's rows, which claimed its aggregate. A run waiting
  // to be resumed is one nobody holds, so the seed gives the claim back.
  await Effect.runPromise(session.releaseClaims(aggregateId('run', RUN_ID)));
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

async function run(context: CliContext, id: RunId = RUN_ID) {
  const { runResumeCommand } = await import('@cli/commands/resumeRun');
  return runResumeCommand(context, id);
}

/** Seed a workflow run the real retrieval resumes. */
async function seedWorkflowResume(config: AgentConfig): Promise<void> {
  await seedRunRecord({ config });
}

describe('runResumeCommand', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedRunRecord({ config: TOOL_USE_CONFIG });
    mocks.resolveCliLaunchAgent.mockReturnValue(
      Effect.succeed({
        name: 'correct',
        category: AgentCategory.Workflow,
      }),
    );
    mocks.runChat.mockResolvedValue({ exitCode: 0 });
    mocks.executeCliWorkflowConfig.mockResolvedValue(0);
    mocks.assertOutputDirAvailable.mockReturnValue(Effect.void);
    mocks.assertOutputFileAvailable.mockReturnValue(Effect.void);
  });

  it('reopens the chat TUI with the persisted tool-use run record', async () => {
    await expect(run(cliContext())).resolves.toBe(0);

    expect(mocks.runChat).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        initialResume: { id: RUN_ID, config: TOOL_USE_CONFIG },
      }),
    );
    expect(mocks.executeCliWorkflowConfig).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('leaves the platform signal handler installed for the TUI to take over', async () => {
    const context = cliContext();

    await run(context);

    expect(mocks.initCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, quietLogs: true }),
    );
    expect(mocks.initCliPlatform.mock.calls[0]?.[0]).not.toHaveProperty(
      'installSignalHandlers',
    );
  });

  it('resumes a workflow run headless under its persisted run id', async () => {
    await seedRunRecord({
      config: WORKFLOW_CONFIG,
      modelCompatibilityKey: 'Anthropic',
    });

    // Headless (non-TTY) is fine for the workflow arm — only tool-use resume
    // needs an interactive terminal.
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      WORKFLOW_CONFIG,
      expect.any(Object),
      expect.objectContaining({
        runId: RUN_ID,
        modelCompatibilityKey: 'Anthropic',
      }),
    );
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith(
      expect.anything(),
      'correct',
      'workflowResume',
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
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

  it('reports a missing workflow agent as a usage error', async () => {
    await seedRunRecord({ config: WORKFLOW_CONFIG });
    mocks.resolveCliLaunchAgent.mockReturnValue(
      Effect.fail(new CliUsageError('Agent not found: correct.')),
    );

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: correct.',
    );
    expect(mocks.executeCliWorkflowConfig).not.toHaveBeenCalled();
  });

  it('rejects tool-use resume when the context says stdout is not a TTY', async () => {
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra resume ${RUN_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra run`.'),
    );
  });

  it('rejects tool-use resume in dumb terminals before falling through to chat', async () => {
    await expect(run(cliContext({ termIsDumb: true }))).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
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
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('reports a run with no checkpoint as finished', async () => {
    await seedRunRecord({
      config: TOOL_USE_CONFIG,
      checkpoint: false,
    });

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'This run has finished. Start a new agent task to continue.',
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it.effect('reports a live run instead of failing silently', () =>
    Effect.gen(function* () {
      yield* seededSession.acquireClaims(aggregateId('run', RUN_ID));
      // The claim is handed back whatever the resume probe does below: the
      // scope close is the `finally` the async body used.
      yield* Effect.addFinalizer(() =>
        seededSession
          .releaseClaims(aggregateId('run', RUN_ID))
          .pipe(Effect.orDie),
      );

      // `runResumeCommand` is the CLI's Promise-facing entry; the test awaits
      // its facade the way the process entry does.
      expect(yield* Effect.promise(() => run(cliContext()))).toBe(2);

      expect(mocks.writeTextStderr).toHaveBeenCalledWith(
        `Run ${RUN_ID} is already running in this process.`,
      );
    }),
  );

  it('refuses a run another live TeXRA process holds, naming its pid', async () => {
    vi.spyOn(seededSession, 'claimOwner').mockReturnValue(
      Effect.succeed({
        ownerId: JSON.stringify(['other-host', 4321, 'start-1']),
        liveness: 'alive',
      }),
    );

    await expect(run(cliContext())).resolves.toBe(CliExitCode.Usage);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Run ${RUN_ID} is held by another TeXRA process (pid 4321 on other-host).`,
    );
  });

  it('identifies claim read failures separately from session loading', async () => {
    vi.spyOn(seededSession, 'claimOwner').mockReturnValue(
      Effect.fail(new Error('claim disk offline')),
    );

    await expect(run(cliContext())).resolves.toBe(1);

    // An unreadable claim says nothing about the checkpoint, so it keeps the
    // operational wording rather than telling the user to delete the run.
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not read the state of run ${RUN_ID}: claim unreadable (claim disk offline)`,
    );
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
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  // A transient failure over a checkpoint that is still on disk says nothing
  // about the record, so it stays the operational error it was. The
  // classification's read of the snapshot succeeds; the resume's own read of
  // the same checkpoint fails, the way a transient storage fault lands
  // mid-command.
  it('reports a transient resume-state load failure as an operational error', async () => {
    await seedWorkflowResume(WORKFLOW_CONFIG);
    let snapshotReads = 0;
    const realLatestSnapshot = seededSession.ledger.latestSnapshot.bind(
      seededSession.ledger,
    );
    vi.spyOn(seededSession.ledger, 'latestSnapshot').mockImplementation(
      (runId) =>
        ++snapshotReads === 1
          ? realLatestSnapshot(runId)
          : Effect.fail(
              new DatabaseReadFailed({
                path: 'run-ledger',
                cause: new Error('KV timeout'),
              }),
            ),
    );

    await expect(run(cliContext())).resolves.toBe(1);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not load session ${RUN_ID}: Failed to retrieve workflow resume data for run: ${RUN_ID}: checkpoint could not be read (KV timeout)`,
    );
  });

  // The positive cohort: the launch folded the run's rows and the ledger
  // refused them, so the user is told the saved state cannot be continued
  // instead of being shown the launch's internal wording.
  it('refuses an aggregate the ledger cannot fold as unusable state', async () => {
    await seedWorkflowResume(WORKFLOW_CONFIG);
    mocks.executeCliWorkflowConfig.mockRejectedValue(
      new RunLedgerRefused({
        reason: 'inconsistent',
        runId: RUN_ID,
        detail: 'unsupported-record',
      }),
    );

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.",
    );
  });
});

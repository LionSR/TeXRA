import '@test/support/sessionGraphTestSetup';
import * as path from 'node:path';

import { Effect } from 'effect';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { getRunRecords } from '@agent/storage/RunKVStore';
import {
  acquireFreshRunLease,
  releaseOwnedRunLease,
} from '@agent/storage/runLease';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { aggregateId } from '@shared/schemas';
import type { FlowSnapshotPayload, RunId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  assertOutputDirAvailable: vi.fn(),
  assertOutputFileAvailable: vi.fn(),
  executeCliWorkflowConfig: vi.fn(),
  initInteractiveCliPlatform: vi.fn(),
  initializeCliTranscriptSession: vi.fn(),
  resolveCliLaunchAgent: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  runChat: vi.fn(),
  writeTextStderr: vi.fn(),
}));

// `texra resume` reopens the chat TUI for tool-use sessions, so it must route
// through initInteractiveCliPlatform — not plain initCliPlatform — to leave
// the TUI as the sole SIGINT/SIGTERM owner once it mounts (see
// initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initInteractiveCliPlatform: mocks.initInteractiveCliPlatform,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/runtime/agents', () => ({
  resolveCliLaunchAgent: mocks.resolveCliLaunchAgent,
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.retrieveSessionResumeData(...args),
      catch: (error) => error,
    }),
}));

vi.mock('@cli/runtime/transcriptSession', () => ({
  initializeCliTranscriptSession: mocks.initializeCliTranscriptSession,
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
    pendingRetry: null,
  },
  references: { pendingIntents: [], pendingResponse: null },
  state: { shouldSkipCycle: false, stateSlices: null },
};

/** Seed the real (fake-platform-backed) run records and run aggregate. */
async function seedRunRecord(seed: {
  readonly config?: AgentConfig | null;
  readonly checkpoint?: boolean;
}): Promise<void> {
  const session = createProcessSession();
  mocks.initializeCliTranscriptSession.mockResolvedValue(session);
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
    await Effect.runPromise(session.ledger.acquire(RUN_ID));
    await Effect.runPromise(
      session.ledger.appendBatch(RUN_ID, null, [
        {
          type: 'flow.snapshot',
          aggregateId: aggregateId('run', RUN_ID),
          payload: OPENING_SNAPSHOT,
        },
      ]),
    );
  }
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

async function stubWorkflowResume(config: AgentConfig): Promise<void> {
  await seedRunRecord({ config });
  mocks.retrieveSessionResumeData.mockResolvedValue({
    type: 'workflow',
    agentConfig: config,
    runId: RUN_ID,
  });
}

describe('runResumeCommand', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.initInteractiveCliPlatform.mockResolvedValue(undefined);
    await seedRunRecord({ config: TOOL_USE_CONFIG });
    mocks.resolveCliLaunchAgent.mockResolvedValue({
      name: 'correct',
      category: AgentCategory.Workflow,
    });
    mocks.runChat.mockResolvedValue({ exitCode: 0 });
    mocks.executeCliWorkflowConfig.mockResolvedValue(0);
    mocks.assertOutputDirAvailable.mockResolvedValue(undefined);
    mocks.assertOutputFileAvailable.mockResolvedValue(undefined);
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

  it('routes platform init through the TUI-owning signal path, not headless init', async () => {
    const context = cliContext();

    await run(context);

    expect(mocks.initInteractiveCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, quietLogs: true }),
    );
  });

  it('resumes a workflow run headless under its persisted run id', async () => {
    await seedRunRecord({ config: WORKFLOW_CONFIG });
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: WORKFLOW_CONFIG,
      runId: RUN_ID,
      modelCompatibilityKey: 'anthropic',
    });

    // Headless (non-TTY) is fine for the workflow arm — only tool-use resume
    // needs an interactive terminal.
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      WORKFLOW_CONFIG,
      expect.any(Object),
      expect.objectContaining({
        runId: RUN_ID,
        modelCompatibilityKey: 'anthropic',
      }),
    );
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith('correct', 'run');
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
    await stubWorkflowResume(workflowConfig);

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
    await stubWorkflowResume(workflowConfig);
    mocks.assertOutputDirAvailable.mockRejectedValue(
      new CliUsageError('--output-dir must refer to a directory.'),
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
    mocks.resolveCliLaunchAgent.mockRejectedValue(
      new CliUsageError('Agent not found: correct.'),
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
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
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

  it('reports a live run instead of failing silently', async () => {
    await acquireFreshRunLease(RUN_ID);
    try {
      await expect(run(cliContext())).resolves.toBe(2);

      expect(mocks.writeTextStderr).toHaveBeenCalledWith(
        `Run ${RUN_ID} is already running in this process.`,
      );
      expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      await releaseOwnedRunLease(RUN_ID);
    }
  });

  it('identifies lease inspection failures separately from session loading', async () => {
    const lease = await import('@agent/storage/runLease');
    vi.spyOn(lease, 'inspectRunLease').mockRejectedValueOnce(
      new Error('lease disk offline'),
    );

    await expect(run(cliContext())).resolves.toBe(1);

    // An unreadable lease says nothing about the checkpoint, so it keeps the
    // operational wording rather than telling the user to delete the run.
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not read the state of run ${RUN_ID}: lease unreadable (lease disk offline)`,
    );
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  // One reader now: the classification and the resume both read the run's
  // latest snapshot. The guarantee that survives the collapse is the negative
  // one — a run whose aggregate still carries a snapshot is never reported to
  // its user as finished.
  it('never reports a run that still has a snapshot as finished', async () => {
    await seedRunRecord({ config: WORKFLOW_CONFIG });
    mocks.retrieveSessionResumeData.mockResolvedValue(null);

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('This run has finished'),
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  // A transient failure over a checkpoint that is still on disk says nothing
  // about the record, so it stays the operational error it was.
  it('reports a transient resume-state load failure as an operational error', async () => {
    await seedRunRecord({ config: WORKFLOW_CONFIG });
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    await expect(run(cliContext())).resolves.toBe(1);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not load session ${RUN_ID}: KV timeout`,
    );
  });

  // The positive cohort: the launch folded the run's rows and the ledger
  // refused them, so the user is told the saved state cannot be continued
  // instead of being shown the launch's internal wording.
  it('refuses an aggregate the ledger cannot fold as unusable state', async () => {
    await stubWorkflowResume(WORKFLOW_CONFIG);
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

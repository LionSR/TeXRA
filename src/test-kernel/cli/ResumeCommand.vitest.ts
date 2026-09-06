import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { flowKey, PersistedFlowStateError } from '@agent/node/persistedFlow';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import {
  acquireFreshExecutionLease,
  releaseOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { ExecutionId, ExecutionMeta } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
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
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@cli/runtime/transcriptSession', () => ({
  initializeCliTranscriptSession: mocks.initializeCliTranscriptSession,
}));

vi.mock('@cli/commands/workflow', () => ({
  executeCliWorkflowConfig: mocks.executeCliWorkflowConfig,
}));

vi.mock('@cli/runtime/workflowOutput', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/workflowOutput')>()),
  assertOutputDirAvailable: mocks.assertOutputDirAvailable,
  assertOutputFileAvailable: mocks.assertOutputFileAvailable,
}));

vi.mock('@cli/chat/tui/runChatTui', () => ({
  runChat: mocks.runChat,
}));

const EXECUTION_ID = 'exec-1' as ExecutionId;
const STREAM_ID = 'planner#exec-1';

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

const STAMPED_META = {
  timestamp: '2026-07-31T00:00:00.000Z',
  streamId: STREAM_ID,
  identity: { kind: 'agent', agent: 'planner' },
} as unknown as ExecutionMeta;

// FK-first: a row without a registration-stamped stream id has no persisted
// stream to continue.
const META_WITHOUT_STREAM_ID = {
  timestamp: '2026-07-31T00:00:00.000Z',
  identity: { kind: 'agent', agent: 'planner' },
} as unknown as ExecutionMeta;

/** Reset and seed the real (fake-platform-backed) execution store. */
async function seedExecution(seed: {
  readonly config?: AgentConfig | null;
  readonly meta?: ExecutionMeta;
  readonly checkpoint?: boolean;
}): Promise<void> {
  const store = getExecutionStore(EXECUTION_ID);
  await Promise.all([
    store.delete('config'),
    store.delete('meta'),
    store.delete(flowKey(EXECUTION_ID)),
  ]);
  if (seed.config) await store.writeRunRecord(seed.config);
  if (seed.meta) await store.writeMeta(seed.meta);
  if (seed.checkpoint !== false) {
    await store.write(flowKey(EXECUTION_ID), {
      shared: {},
      cursor: { nextNodeId: 'start' },
    });
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

async function run(context: CliContext, id: ExecutionId = EXECUTION_ID) {
  const { runResumeExecution } = await import('@cli/commands/resumeExecution');
  return runResumeExecution(context, id);
}

async function stubWorkflowResume(config: AgentConfig): Promise<void> {
  await seedExecution({ config, meta: STAMPED_META });
  mocks.retrieveSessionResumeData.mockResolvedValue({
    type: 'workflow',
    agentConfig: config,
    executionId: EXECUTION_ID,
  });
}

describe('runResumeExecution', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.initInteractiveCliPlatform.mockResolvedValue(undefined);
    mocks.initializeCliTranscriptSession.mockResolvedValue({
      interactions: {},
      executions: { isActiveOrResuming: () => false },
      // `resumeRun` drops any stale read-only hold when it opens the run
      // for write, and records one when the lease refuses it.
      status: {
        clearHold: () => undefined,
        markUnavailableOrLog: () => undefined,
      },
      snapshots: {
        getRunMetadata: () => ({ executionId: EXECUTION_ID }),
        getParentStreamId: () => undefined,
        preload: async () => undefined,
      },
    });
    await seedExecution({ config: TOOL_USE_CONFIG, meta: STAMPED_META });
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
        initialResume: { id: EXECUTION_ID, config: TOOL_USE_CONFIG },
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

  it('resumes a workflow run headless under its persisted execution id', async () => {
    await seedExecution({ config: WORKFLOW_CONFIG, meta: STAMPED_META });
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'workflow',
      agentConfig: WORKFLOW_CONFIG,
      executionId: EXECUTION_ID,
      modelHandlerCompatibilityKey: 'anthropic',
    });

    // Headless (non-TTY) is fine for the workflow arm — only tool-use resume
    // needs an interactive terminal.
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      WORKFLOW_CONFIG,
      expect.any(Object),
      expect.objectContaining({
        executionId: EXECUTION_ID,
        modelHandlerCompatibilityKey: 'anthropic',
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

  it('preserves whitespace in a persisted workflow output directory', async () => {
    const workingDirectory = path.join(path.sep, 'tmp', 'paper');
    const outputDirectory = path.join(workingDirectory, ' out ');
    const workflowConfig = AgentConfigSchema.parse({
      ...WORKFLOW_CONFIG,
      workingDirectory,
      cli: { outputDirectory },
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
    await seedExecution({ config: WORKFLOW_CONFIG, meta: STAMPED_META });
    mocks.resolveCliLaunchAgent.mockRejectedValue(
      new CliUsageError('Agent not found: correct.'),
    );

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: correct.',
    );
    expect(mocks.initializeCliTranscriptSession).not.toHaveBeenCalled();
    expect(mocks.executeCliWorkflowConfig).not.toHaveBeenCalled();
  });

  it('rejects tool-use resume when the context says stdout is not a TTY', async () => {
    await expect(run(cliContext({ stdoutIsTty: false }))).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra resume ${EXECUTION_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra run`.'),
    );
  });

  it('uses the local launcher in headless resume guidance', async () => {
    await expect(
      run(cliContext({ commandName: 'texra-local', stdoutIsTty: false })),
    ).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra-local resume ${EXECUTION_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra-local run`.'),
    );
  });

  it('rejects tool-use resume in dumb terminals before falling through to chat', async () => {
    await expect(run(cliContext({ termIsDumb: true }))).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'texra resume needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`. For non-interactive runs, use `texra run`.',
    );
  });

  it('reports an unknown execution id as a usage error', async () => {
    await seedExecution({ config: null, meta: STAMPED_META });

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution not found: ${EXECUTION_ID}`,
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('names stream stamping when a row has no stream id', async () => {
    await seedExecution({
      config: TOOL_USE_CONFIG,
      meta: META_WITHOUT_STREAM_ID,
    });

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution ${EXECUTION_ID} predates transcript stream stamping and cannot be continued. Start a new agent task instead.`,
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('reports a run with no checkpoint as finished', async () => {
    await seedExecution({
      config: TOOL_USE_CONFIG,
      meta: STAMPED_META,
      checkpoint: false,
    });

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'This run has finished. Start a new agent task to continue.',
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('reports a live execution instead of failing silently', async () => {
    await acquireFreshExecutionLease(EXECUTION_ID);
    try {
      await expect(run(cliContext())).resolves.toBe(2);

      expect(mocks.writeTextStderr).toHaveBeenCalledWith(
        `Execution ${EXECUTION_ID} is already running in this process.`,
      );
      expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      await releaseOwnedExecutionLease(EXECUTION_ID);
    }
  });

  it('identifies lease inspection failures separately from session loading', async () => {
    const lease = await import('@agent/storage/executionLease');
    vi.spyOn(lease, 'inspectExecutionLease').mockRejectedValueOnce(
      new Error('lease disk offline'),
    );

    await expect(run(cliContext())).resolves.toBe(1);

    // An unreadable lease says nothing about the checkpoint, so it keeps the
    // operational wording rather than telling the user to delete the run.
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not read the state of execution ${EXECUTION_ID}: lease unreadable (lease disk offline)`,
    );
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  // The checkpoint this seeds is readable, so the empty retrieval is the two
  // readers disagreeing, not a finished run. The lease-aware classification
  // decides that first and still sees a checkpoint; a history listing
  // advertises a row from that file alone, so what the user is told is that
  // the saved state could not be loaded, never that the run finished.
  it('separates an unusable checkpoint from a run that finished', async () => {
    await seedExecution({ config: WORKFLOW_CONFIG, meta: STAMPED_META });
    mocks.retrieveSessionResumeData.mockResolvedValue(null);

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.",
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  // A transient failure over a checkpoint that is still on disk says nothing
  // about the record, so it stays the operational error it was.
  it('reports a transient resume-state load failure as an operational error', async () => {
    await seedExecution({ config: WORKFLOW_CONFIG, meta: STAMPED_META });
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    await expect(run(cliContext())).resolves.toBe(1);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not load session ${EXECUTION_ID}: KV timeout`,
    );
  });

  // The positive cohort: retrieval named the record itself, which is what a
  // listing advertised from the file alone, so it earns the unusable-state
  // refusal instead of an internal retrieval message.
  it('refuses a checkpoint whose record cannot be resumed as unusable state', async () => {
    await seedExecution({ config: WORKFLOW_CONFIG, meta: STAMPED_META });
    mocks.retrieveSessionResumeData.mockRejectedValue(
      new PersistedFlowStateError(EXECUTION_ID, 'unsupported-record'),
    );

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      "This run's saved state could not be loaded, so it cannot be continued. Delete it from history and start a new agent task.",
    );
  });
});

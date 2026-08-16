import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  acquireFreshExecutionLease,
  releaseOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const mocks = vi.hoisted(() => ({
  assertOutputDirAvailable: vi.fn(),
  assertOutputFileAvailable: vi.fn(),
  executeCliWorkflowConfig: vi.fn(),
  initInteractiveCliPlatform: vi.fn(),
  initializeHeadlessTranscriptSession: vi.fn(),
  readConfig: vi.fn(),
  readMeta: vi.fn(),
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

vi.mock('@agent/storage', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage')>()),
  getExecutionStore: () => ({
    readConfig: mocks.readConfig,
    readMeta: mocks.readMeta,
  }),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@cli/runtime/transcriptSession', () => ({
  initializeHeadlessTranscriptSession:
    mocks.initializeHeadlessTranscriptSession,
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
};

// FK-first: a row without a registration-stamped stream id has no persisted
// stream to continue.
const META_WITHOUT_STREAM_ID = {
  timestamp: '2026-07-31T00:00:00.000Z',
  identity: { kind: 'agent', agent: 'planner' },
};

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

function stubWorkflowResume(config: AgentConfig): void {
  mocks.readConfig.mockResolvedValue(config);
  mocks.retrieveSessionResumeData.mockResolvedValue({
    type: 'workflow',
    agentConfig: config,
    executionId: EXECUTION_ID,
  });
}

describe('runResumeExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initInteractiveCliPlatform.mockResolvedValue(undefined);
    mocks.initializeHeadlessTranscriptSession.mockResolvedValue({
      session: {
        interactions: {},
        status: { isActiveOrResuming: () => false },
      },
    });
    mocks.readConfig.mockResolvedValue(TOOL_USE_CONFIG);
    mocks.readMeta.mockResolvedValue(STAMPED_META);
    mocks.resolveCliLaunchAgent.mockResolvedValue({
      name: 'correct',
      category: AgentCategory.Workflow,
    });
    mocks.retrieveSessionResumeData.mockResolvedValue(
      createToolUseResumeData({
        executionId: EXECUTION_ID,
        streamId: STREAM_ID,
      }),
    );
    mocks.runChat.mockResolvedValue({ exitCode: 0 });
    mocks.executeCliWorkflowConfig.mockResolvedValue(0);
    mocks.assertOutputDirAvailable.mockResolvedValue(undefined);
    mocks.assertOutputFileAvailable.mockResolvedValue(undefined);
  });

  it('reopens the chat TUI with the retrieved tool-use resume state', async () => {
    const resolution = createToolUseResumeData({
      executionId: EXECUTION_ID,
      streamId: STREAM_ID,
    });

    await expect(run(cliContext())).resolves.toBe(0);

    expect(mocks.runChat).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        initialResume: { id: EXECUTION_ID, resolution },
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
    mocks.readConfig.mockResolvedValue(WORKFLOW_CONFIG);
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
      cliOutputDirectory: outputDirectory,
      cliExpectedOutputFiles: ['paper.tex', 'appendix.tex'],
    });
    stubWorkflowResume(workflowConfig);

    await expect(run(cliContext())).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      workflowConfig,
      expect.any(Object),
      expect.objectContaining({
        outputDir: outputDirectory,
        expectedOutputFiles: ['paper.tex', 'appendix.tex'],
      }),
    );
  });

  it('preserves whitespace in a persisted workflow output directory', async () => {
    const workingDirectory = path.join(path.sep, 'tmp', 'paper');
    const outputDirectory = path.join(workingDirectory, ' out ');
    const workflowConfig = AgentConfigSchema.parse({
      ...WORKFLOW_CONFIG,
      workingDirectory,
      cliOutputDirectory: outputDirectory,
    });
    stubWorkflowResume(workflowConfig);

    await expect(run(cliContext())).resolves.toBe(0);

    expect(mocks.executeCliWorkflowConfig).toHaveBeenCalledWith(
      workflowConfig,
      expect.any(Object),
      expect.objectContaining({
        outputDir: outputDirectory,
      }),
    );
  });

  it('validates a restored output directory before resuming the workflow', async () => {
    const workingDirectory = path.join(path.sep, 'tmp', 'paper');
    const workflowConfig = AgentConfigSchema.parse({
      ...WORKFLOW_CONFIG,
      workingDirectory,
      cliOutputDirectory: path.join(workingDirectory, 'out'),
    });
    stubWorkflowResume(workflowConfig);
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
    mocks.readConfig.mockResolvedValue(WORKFLOW_CONFIG);
    mocks.resolveCliLaunchAgent.mockRejectedValue(
      new CliUsageError('Agent not found: correct.'),
    );

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: correct.',
    );
    expect(mocks.initializeHeadlessTranscriptSession).not.toHaveBeenCalled();
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
    mocks.readConfig.mockResolvedValue(null);

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution not found: ${EXECUTION_ID}`,
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('reports a row without a stamped stream id as not resumable', async () => {
    mocks.readMeta.mockResolvedValue(META_WITHOUT_STREAM_ID);

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution ${EXECUTION_ID} cannot be resumed (it completed or was cleared).`,
    );
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('reports a live execution instead of failing silently', async () => {
    await acquireFreshExecutionLease(EXECUTION_ID);
    try {
      await expect(run(cliContext())).resolves.toBe(2);

      expect(mocks.writeTextStderr).toHaveBeenCalledWith(
        `Execution ${EXECUTION_ID} is active in TeXRA.`,
      );
      expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    } finally {
      await releaseOwnedExecutionLease(EXECUTION_ID);
    }
  });

  it('identifies lease inspection failures separately from session loading', async () => {
    const storage = await import('@agent/storage');
    vi.spyOn(storage, 'inspectExecutionLease').mockRejectedValueOnce(
      new Error('lease disk offline'),
    );

    await expect(run(cliContext())).resolves.toBe(1);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not check whether execution ${EXECUTION_ID} is active: lease disk offline`,
    );
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('reports empty retrieval as not resumable', async () => {
    mocks.retrieveSessionResumeData.mockResolvedValue(null);

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution ${EXECUTION_ID} cannot be resumed (it completed or was cleared).`,
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('reports resume-state load failures as operational errors', async () => {
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    await expect(run(cliContext())).resolves.toBe(1);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Could not load session ${EXECUTION_ID}: KV timeout`,
    );
  });
});

// `readCliToolUseResumeData` is the chat-session feed for the same resume
// surface (`/resume` inside the chat TUI). It reads the same storage and
// retrieval seams this file already mocks, so its unit tests live here; the
// agent-category branch runs for real against the minimal configs above.
describe('readCliToolUseResumeData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readMeta.mockResolvedValue(STAMPED_META);
  });

  async function read(config: AgentConfig, id: ExecutionId = EXECUTION_ID) {
    const { readCliToolUseResumeData } =
      await import('@cli/runtime/toolUseResumeData');
    return readCliToolUseResumeData(id, config);
  }

  it('returns null for a workflow config (resumed via the shared funnel)', async () => {
    expect(await read(WORKFLOW_CONFIG)).toBeNull();
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns canonical tool-use state when a flow record exists', async () => {
    const resume = createToolUseResumeData({
      executionId: EXECUTION_ID,
      streamId: STREAM_ID,
      agentConfig: { ...TOOL_USE_CONFIG, model: 'gpt-5.5' },
    });
    mocks.retrieveSessionResumeData.mockResolvedValue(resume);

    expect(await read(TOOL_USE_CONFIG)).toEqual(resume);
    // The stream id is the one stamped on execution metadata at registration,
    // never re-derived from agent/model, so resume reuses the original
    // stream/transcript.
    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      STREAM_ID,
      EXECUTION_ID,
      TOOL_USE_CONFIG,
    );
  });

  it('returns null when metadata carries no stamped stream id', async () => {
    mocks.readMeta.mockResolvedValue(META_WITHOUT_STREAM_ID);

    expect(await read(TOOL_USE_CONFIG)).toBeNull();
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('returns null without a live flow record', async () => {
    mocks.retrieveSessionResumeData.mockResolvedValue(undefined);

    expect(await read(TOOL_USE_CONFIG)).toBeNull();
  });

  it('propagates retrieval failures for the active-resume path to surface', async () => {
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    await expect(read(TOOL_USE_CONFIG)).rejects.toThrow('KV timeout');
  });

  it('discards a non-toolUse resume payload', async () => {
    mocks.retrieveSessionResumeData.mockResolvedValue({ type: 'workflow' });

    expect(await read(TOOL_USE_CONFIG)).toBeNull();
  });
});

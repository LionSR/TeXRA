import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { CliContext } from '@cli/runtime/cliContext';
import type { ExecutionId } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const mocks = vi.hoisted(() => ({
  executeCliWorkflowConfig: vi.fn(),
  initInteractiveCliPlatform: vi.fn(),
  initializeHeadlessTranscriptSession: vi.fn(),
  readConfig: vi.fn(),
  readMeta: vi.fn(),
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
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-07-31T00:00:00.000Z',
      streamId: STREAM_ID,
      identity: { kind: 'agent', agent: 'planner' },
    });
    mocks.retrieveSessionResumeData.mockResolvedValue(
      createToolUseResumeData({
        executionId: EXECUTION_ID,
        streamId: STREAM_ID,
      }),
    );
    mocks.runChat.mockResolvedValue({ exitCode: 0 });
    mocks.executeCliWorkflowConfig.mockResolvedValue(0);
  });

  it('reopens the chat TUI with the retrieved tool-use resume state', async () => {
    const resolution = createToolUseResumeData({
      executionId: EXECUTION_ID,
      streamId: STREAM_ID,
    });
    mocks.retrieveSessionResumeData.mockResolvedValue(resolution);

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
    mocks.executeCliWorkflowConfig.mockResolvedValue(0);

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
    expect(mocks.runChat).not.toHaveBeenCalled();
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
    // FK-first: a row without a registration-stamped stream id has no
    // persisted stream to continue.
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-07-31T00:00:00.000Z',
      identity: { kind: 'agent', agent: 'planner' },
    });

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution ${EXECUTION_ID} has no resumable session state (it completed or was cleared).`,
    );
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
  });

  it('reports empty retrieval as not resumable', async () => {
    mocks.retrieveSessionResumeData.mockResolvedValue(null);

    await expect(run(cliContext())).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Execution ${EXECUTION_ID} has no resumable session state (it completed or was cleared).`,
    );
    expect(mocks.runChat).not.toHaveBeenCalled();
  });

  it('reports resume-state load failures as operational errors', async () => {
    mocks.retrieveSessionResumeData.mockRejectedValue(new Error('KV timeout'));

    await expect(run(cliContext())).resolves.toBe(1);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Failed to load resumable session ${EXECUTION_ID}: KV timeout`,
    );
  });
});

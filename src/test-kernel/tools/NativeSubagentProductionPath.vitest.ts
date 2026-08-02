/**
 * Production-shaped regression for #9531. Agent registration, launch, child
 * looping, persisted resume, result/report writes, parent admission, recovery,
 * and transcript reopening are real. Only the external model transport is
 * replaced by the deterministic handlers below.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modelFactoryMocks = vi.hoisted(() => ({
  createModelHandler: vi.fn(),
}));

vi.mock('@agent/runtime/ModelFactory', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/ModelFactory')>()),
  createModelHandler: modelFactoryMocks.createModelHandler,
  createModelHandlerForCompatibilityKey: modelFactoryMocks.createModelHandler,
}));

// Local imports - agent runtime
import { clearInlineAgents, registerInlineAgents } from '@agent/index';
import {
  clearStoreCache,
  getExecutionStore,
  registerExecution,
} from '@agent/storage';
import {
  captureOwnedExecutionLease,
  releaseOwnedExecutionLease,
  waitForOwnedExecutionLeaseRelease,
} from '@agent/storage/executionLease';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { ModelCell } from '@agent/runtime/ModelCell';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { resumeQueuedToolUseFromResumeData } from '@agent/runtime/resumeQueuedToolUse';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - shared/runtime boundaries
import type { RecoveryContinuation } from '@platform/interfaces';
import type { Platform } from '@platform/platform';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { roundModelHandler } from '@test/agent/toolUseRoundTestUtils';
import { DelegateAgentTool } from '@tools/DelegationTools';
import { executeSubagent } from '@tools/delegation/subagentExecution';
import { readCompletedRunConversation, StreamLogStore } from '@transcript';

const PARENT_EXECUTION_ID = 'a9531a9531a9' as ExecutionId;
const OUTER_EXECUTION_ID = '0a95310a9531' as ExecutionId;
const OUTER_STREAM_ID = 'outer_9531@gpt54#0a95310a9531' as StreamTabId;
const PARENT_STREAM_ID = 'parent_9531@gpt54#a9531a9531a9' as StreamTabId;
const PARENT_AGENT = 'parent_9531';
const CHILD_AGENT = 'child_9531';
const PARENT_MODEL = 'gpt54';
const CHILD_MODEL = 'gpt55';
const MODEL_HANDLER_KEY = 'ModelHandlerOpenAIResponse';

const tempDirs: string[] = [];
let session: SessionHandle;
let childId: ExecutionId | undefined;
let resumedStreams: StreamTabId[];

interface ScriptedTurn {
  readonly text: string;
}

function taggedScriptedHandler(
  model: string,
  turns: ScriptedTurn[],
  observedFollowUps: Array<{
    readonly model: string;
    readonly messages: readonly unknown[];
    readonly text: string;
  }>,
) {
  const handler = roundModelHandler({
    capabilities: {
      supportsFunctionCalling: true,
      supportsNativeAudio: false,
      supportsVision: false,
    },
    config: { provider: 'openai', fullName: model },
    requiresPerCallSystemPrompt: false,
    initializeMessages: async () => [{ role: 'user', content: 'Start.' }],
    consumeInsertedAttachmentKinds: () => [],
    createUserFollowUpMessages: async (
      messages: readonly unknown[],
      text: string,
    ) => {
      observedFollowUps.push({
        model,
        messages: structuredClone(messages),
        text,
      });
      return [...messages, { role: 'user', content: text }];
    },
    createResponse: vi.fn(async () => {
      const turn = turns.shift();
      if (!turn) throw new Error(`Unexpected ${model} model invocation.`);
      return { response: turn };
    }),
    extractResponse: (response: unknown) => ({
      text: (response as ScriptedTurn).text,
      usage: null,
      stopReason: 'stop',
    }),
    extractToolUse: () => [],
    extractAssistantText: (message: { content?: unknown }) =>
      typeof message.content === 'string' ? message.content : undefined,
    setAgentCategory: vi.fn(),
    setLogger: vi.fn(),
    dispose: vi.fn(),
  });
  Object.defineProperty(handler, '__texraModelHandlerCompatibilityKey', {
    value: MODEL_HANDLER_KEY,
  });
  return handler;
}

async function resumePersistedStream(
  streamId: StreamTabId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  resumedStreams.push(streamId);
  const executionId = streamId.slice(
    streamId.lastIndexOf('#') + 1,
  ) as ExecutionId;
  const config = await getExecutionStore(executionId).readConfig();
  if (!config) return false;
  const resume = await retrieveSessionResumeData(streamId, executionId, config);
  if (!resume || resume.type !== 'toolUse') return false;
  return resumeQueuedToolUseFromResumeData(streamId, resume, {
    session,
    recovery,
    onError: (error) => {
      throw error;
    },
  });
}

async function integrationPlatform(): Promise<Platform> {
  return {
    ...(await createTempDirPlatform('texra-9531-production-', tempDirs)),
    agentResume: { tryResumeStream: resumePersistedStream },
  };
}

function inlineAgent(name: string) {
  return {
    name,
    description: `Integration fixture ${name}.`,
    settings: { agentCategory: AgentCategory.ToolUse, tools: [] },
    prompts: { systemPrompt: `You are ${name}.` },
  };
}

async function waitForReport(
  executionId: ExecutionId,
  expectedText: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const report = await getExecutionStore(executionId).readReport();
      expect(report).toContain(expectedText);
    },
    { timeout: 10_000 },
  );
}

function childExecutionId(resultOutput: string | undefined): ExecutionId {
  const match = resultOutput?.match(/Execution ID: (\S+)/);
  if (!match?.[1])
    throw new Error('Delegation result omitted its execution ID.');
  return match[1] as ExecutionId;
}

describe('native subagent production delivery path', () => {
  setupPlatform(integrationPlatform);

  beforeEach(async () => {
    clearStoreCache();
    clearInlineAgents();
    registerInlineAgents([inlineAgent(PARENT_AGENT), inlineAgent(CHILD_AGENT)]);
    session = new SessionHandle({ transcripts: await StreamLogStore.open() });
    childId = undefined;
    resumedStreams = [];
  });

  afterEach(async () => {
    for (const executionId of session.executions.getActiveIds()) {
      const handle = session.executions.getHandle(executionId);
      if (handle instanceof AgentExecutionHandle) handle.interrupt();
    }
    if (childId) await waitForOwnedExecutionLeaseRelease(childId);
    await releaseOwnedExecutionLease(PARENT_EXECUTION_ID);
    session.dispose();
    clearInlineAgents();
    clearStoreCache();
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  it('resumes one persisted child through the real queue and archives both turns once', async () => {
    const parentTurns = [
      { text: 'Parent ready.' },
      { text: 'Parent received result A.' },
      { text: 'Parent received result B.' },
    ];
    const childTurns = [{ text: 'Result A.' }, { text: 'Result B.' }];
    const observedFollowUps: Array<{
      readonly model: string;
      readonly messages: readonly unknown[];
      readonly text: string;
    }> = [];
    modelFactoryMocks.createModelHandler.mockImplementation(
      async (modelConfig: { name: string }) =>
        taggedScriptedHandler(
          modelConfig.name,
          modelConfig.name === CHILD_MODEL ? childTurns : parentTurns,
          observedFollowUps,
        ),
    );

    const parentConfig = AgentConfigSchema.parse({
      agent: PARENT_AGENT,
      agentSource: 'inline',
      agentCategory: AgentCategory.ToolUse,
      model: PARENT_MODEL,
      instruction: 'Coordinate the child proof review.',
      workingDirectory: process.cwd(),
    });
    await registerExecution(PARENT_EXECUTION_ID, parentConfig, PARENT_AGENT, {
      streamId: PARENT_STREAM_ID,
      parentExecutionId: OUTER_EXECUTION_ID,
    });
    await expect(
      executeAgent(parentConfig, PARENT_EXECUTION_ID, {
        session,
        allowWaitingResult: true,
        isSubagent: true,
        parentStreamId: OUTER_STREAM_ID,
      }),
    ).resolves.toMatchObject({
      outcome: STREAM_PHASE.WAITING,
      response: 'Parent ready.',
    });

    const parentContext = createRunContext({
      streamId: PARENT_STREAM_ID,
      executionId: PARENT_EXECUTION_ID,
      modelCell: new ModelCell({} as never, PARENT_MODEL),
      session,
    });
    const runAsParentOwner = captureOwnedExecutionLease(PARENT_EXECUTION_ID);
    const launch = await runAsParentOwner(() =>
      withRunContext(parentContext, () =>
        executeSubagent(
          {
            agent: CHILD_AGENT,
            agentSource: 'inline',
            agentCategory: AgentCategory.ToolUse,
            model: CHILD_MODEL,
            instruction: 'Prove the first assertion.',
            memories: [],
            workingDirectory: process.cwd(),
          },
          CHILD_AGENT,
          PARENT_STREAM_ID,
        ),
      ),
    );
    expect(launch.status).toBe('executed');
    const executionId = childExecutionId(launch.output);
    childId = executionId;

    await waitForReport(executionId, 'Result A.');
    await expect(
      getExecutionStore(executionId).readResultMeta(),
    ).resolves.toMatchObject({
      result: { response: 'Result A.' },
    });
    await vi.waitFor(() => expect(parentTurns).toHaveLength(1), {
      timeout: 10_000,
    });

    const resumed = await runAsParentOwner(() =>
      withRunContext(parentContext, () =>
        new DelegateAgentTool().call({
          agent: null,
          model: null,
          instruction: 'Now prove the second assertion.',
          memories: [],
          working_directory: null,
          execution_id: executionId,
        }),
      ),
    );
    expect(resumed.status).toBe('executed');
    expect(resumed.summary).toContain('Follow-up queued');

    await waitForReport(executionId, 'Result B.');
    await expect(
      getExecutionStore(executionId).readResultMeta(),
    ).resolves.toMatchObject({
      result: { response: 'Result B.' },
    });
    await vi.waitFor(() => expect(parentTurns).toHaveLength(0), {
      timeout: 10_000,
    });

    const childResumeInput = observedFollowUps.find(
      ({ model, text }) =>
        model === CHILD_MODEL && text.includes('second assertion'),
    );
    expect(childResumeInput?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'Result A.' }),
      ]),
    );

    await session.transcripts.flush();
    const archivedChild = await readCompletedRunConversation(executionId);
    expect(archivedChild.conversation).toEqual([
      expect.objectContaining({ role: 'user' }),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Result A.' }],
      },
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('second assertion'),
      }),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Result B.' }],
      },
    ]);

    const archivedParent =
      await readCompletedRunConversation(PARENT_EXECUTION_ID);
    const parentText = JSON.stringify(archivedParent.conversation);
    expect(parentText.match(/Result A\./g)).toHaveLength(1);
    expect(parentText.match(/Result B\./g)).toHaveLength(1);
    expect(archivedParent.conversation).toEqual(
      expect.arrayContaining([
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Parent received result A.' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Parent received result B.' }],
        },
      ]),
    );
    expect(resumedStreams).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
  }, 30_000);
});

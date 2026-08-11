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
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { ModelCell } from '@agent/runtime/ModelCell';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { resumeQueuedToolUseFromResumeData } from '@agent/runtime/resumeQueuedToolUse';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - shared/runtime boundaries
import { deliverChildRunFollowUp } from '@agent/followUp/childRunDelivery';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { Platform } from '@platform/platform';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { roundModelHandler } from '@test/agent/toolUseRoundTestUtils';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
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
let completedResumes: StreamTabId[];

interface ScriptedTurn {
  readonly text: string;
}

interface ObservedFollowUp {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly text: string;
}

function taggedScriptedHandler(
  model: string,
  turns: Array<ScriptedTurn | 'hang'>,
  observedFollowUps: ObservedFollowUp[],
  hangGate?: Promise<unknown>,
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
      if (turn === 'hang') {
        await hangGate;
        throw new Error(`Hang gate for ${model} resolved unexpectedly.`);
      }
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
  const resumed = await resumeQueuedToolUseFromResumeData(streamId, resume, {
    session,
    recovery,
    onError: (error) => {
      throw error;
    },
  });
  completedResumes.push(streamId);
  return resumed;
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

async function waitForPersistedResult(
  executionId: ExecutionId,
  expectedText: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const report = await getExecutionStore(executionId).readReport();
      expect(report).toContain(expectedText);
      await expect(
        getExecutionStore(executionId).readResultMeta(),
      ).resolves.toMatchObject({
        result: { response: expectedText },
      });
    },
    { timeout: 20_000 },
  );
}

function childExecutionId(resultOutput: string | undefined): ExecutionId {
  const match = resultOutput?.match(/Execution ID: (\S+)/);
  if (!match?.[1])
    throw new Error('Delegation result omitted its execution ID.');
  return match[1] as ExecutionId;
}

async function waitForCompletedResumes(count: number): Promise<void> {
  await vi.waitFor(() => expect(completedResumes).toHaveLength(count), {
    timeout: 10_000,
  });
}

/**
 * Queue the second-assertion follow-up onto a WAITING child through the real
 * DelegateAgentTool path, asserting the queue accepted it.
 */
async function queueSecondAssertionFollowUp(
  parentContext: ReturnType<typeof createRunContext>,
  runAsParentOwner: ReturnType<typeof captureOwnedExecutionLease>,
  executionId: ExecutionId,
  instruction = 'Now prove the second assertion.',
) {
  const resumed = await runAsParentOwner(() =>
    withRunContext(parentContext, () =>
      new DelegateAgentTool().call({
        agent: null,
        model: null,
        instruction,
        memories: [],
        working_directory: null,
        execution_id: executionId,
      }),
    ),
  );
  expect(resumed.status).toBe('executed');
  return resumed;
}

/**
 * Shared production-shaped setup: a WAITING scripted parent launches a native
 * tool-use child through the real delegation path. Returns once the launch is
 * accepted; the child's first turn may still be in flight.
 */
async function launchWaitingChild(options: {
  readonly parentTurns: Array<ScriptedTurn | 'hang'>;
  readonly childTurns: Array<ScriptedTurn | 'hang'>;
  readonly childGate?: Promise<unknown>;
}): Promise<{
  readonly executionId: ExecutionId;
  readonly parentContext: ReturnType<typeof createRunContext>;
  readonly runAsParentOwner: ReturnType<typeof captureOwnedExecutionLease>;
  readonly observedFollowUps: ObservedFollowUp[];
}> {
  const observedFollowUps: ObservedFollowUp[] = [];
  modelFactoryMocks.createModelHandler.mockImplementation(
    async (modelConfig: { name: string }) =>
      taggedScriptedHandler(
        modelConfig.name,
        modelConfig.name === CHILD_MODEL
          ? options.childTurns
          : options.parentTurns,
        observedFollowUps,
        options.childGate,
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
    identity: { kind: 'agent', agent: PARENT_AGENT },
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
  return {
    executionId,
    parentContext,
    runAsParentOwner,
    observedFollowUps,
  };
}

describe('native subagent production delivery path', { retry: 2 }, () => {
  setupPlatform(integrationPlatform);

  beforeEach(async () => {
    clearStoreCache();
    clearInlineAgents();
    registerInlineAgents([inlineAgent(PARENT_AGENT), inlineAgent(CHILD_AGENT)]);
    session = new SessionHandle({ transcripts: await StreamLogStore.open() });
    childId = undefined;
    resumedStreams = [];
    completedResumes = [];
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
    const { executionId, parentContext, runAsParentOwner, observedFollowUps } =
      await launchWaitingChild({ parentTurns, childTurns });

    await waitForPersistedResult(executionId, 'Result A.');
    await waitForCompletedResumes(1);

    const resumed = await queueSecondAssertionFollowUp(
      parentContext,
      runAsParentOwner,
      executionId,
    );
    expect(resumed.summary).toContain('Follow-up queued');

    await waitForPersistedResult(executionId, 'Result B.');
    await waitForCompletedResumes(2);

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
    expect(completedResumes).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
    expect(parentTurns).toHaveLength(0);
  }, 60_000);

  it('does not redeliver turn 1 when the resumed turn produces no new assistant message', async () => {
    const parentTurns = [
      { text: 'Parent ready.' },
      { text: 'Parent received result A.' },
      { text: 'Parent closed out an empty second turn.' },
    ];
    // Turn 2 is answerless: the scripted transport ends the turn with no text,
    // so the resumed cycle completes without adding an assistant message.
    const childTurns = [{ text: 'Result A.' }, { text: '' }];
    const { executionId, parentContext, runAsParentOwner } =
      await launchWaitingChild({ parentTurns, childTurns });

    await waitForPersistedResult(executionId, 'Result A.');
    await waitForCompletedResumes(1);

    const resumed = await queueSecondAssertionFollowUp(
      parentContext,
      runAsParentOwner,
      executionId,
    );
    expect(resumed.summary).toContain('Follow-up queued');

    // The answerless turn still delivers: its report/result overwrite turn 1's
    // with an explicitly empty response rather than replaying 'Result A.' — and
    // the parent is resumed a second time to consume that empty delivery.
    await vi.waitFor(
      async () => {
        await expect(
          getExecutionStore(executionId).readResultMeta(),
        ).resolves.toMatchObject({
          result: { response: '' },
        });
        const report = await getExecutionStore(executionId).readReport();
        expect(report).not.toContain('Result A.');
        expect(report).not.toContain('<response>');
      },
      { timeout: 10_000 },
    );
    await waitForCompletedResumes(2);

    await session.transcripts.flush();
    const archivedChild = await readCompletedRunConversation(executionId);
    // Turn 2 added the user instruction but no new assistant row.
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
    ]);

    const archivedParent =
      await readCompletedRunConversation(PARENT_EXECUTION_ID);
    const parentText = JSON.stringify(archivedParent.conversation);
    expect(parentText.match(/Result A\./g)).toHaveLength(1);
    expect(resumedStreams).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
    expect(completedResumes).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
    expect(parentTurns).toHaveLength(0);
  }, 60_000);

  it('combines concurrent distinct follow-ups into one ordered batch turn, not an overwritten result', async () => {
    // Two child turns: the initial launch plus one batch turn that drains both
    // concurrent follow-ups together.
    const parentTurns = [
      { text: 'Parent ready.' },
      { text: 'Parent received result A.' },
      { text: 'Parent received result B.' },
    ];
    const childTurns = [{ text: 'Result A.' }, { text: 'Result B.' }];
    const { executionId, parentContext, runAsParentOwner } =
      await launchWaitingChild({ parentTurns, childTurns });

    await waitForPersistedResult(executionId, 'Result A.');
    await waitForCompletedResumes(1);

    // Submit two follow-ups concurrently, before the child drains the queue.
    // The loop drains the follow-up batch (waitAndDrainAll) and runs one turn
    // with the combined batch, so both instructions reach the child in one
    // ordered turn rather than sharing/overwriting one turn result.
    const [first, second] = await Promise.all([
      queueSecondAssertionFollowUp(
        parentContext,
        runAsParentOwner,
        executionId,
        'Now prove the second assertion.',
      ),
      queueSecondAssertionFollowUp(
        parentContext,
        runAsParentOwner,
        executionId,
        'Now prove the third assertion.',
      ),
    ]);
    expect(first.status).toBe('executed');
    expect(second.status).toBe('executed');

    await waitForPersistedResult(executionId, 'Result B.');
    await waitForCompletedResumes(2);

    // The child transcript has turn 1 (Result A) and the batch turn (Result B),
    // with BOTH follow-up instructions recorded as user messages in the batch.
    await session.transcripts.flush();
    const archivedChild = await readCompletedRunConversation(executionId);
    const childText = JSON.stringify(archivedChild.conversation);
    expect(childText.match(/Result A\./g)).toHaveLength(1);
    expect(childText.match(/Result B\./g)).toHaveLength(1);
    expect(childText).toContain('second assertion');
    expect(childText).toContain('third assertion');

    // The parent received each distinct result exactly once.
    const archivedParent =
      await readCompletedRunConversation(PARENT_EXECUTION_ID);
    const parentText = JSON.stringify(archivedParent.conversation);
    expect(parentText.match(/Result A\./g)).toHaveLength(1);
    expect(parentText.match(/Result B\./g)).toHaveLength(1);
    expect(resumedStreams).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
    expect(completedResumes).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
    expect(parentTurns).toHaveLength(0);
  }, 60_000);

  it('suppresses replays of one logical child delivery at the real admission boundary', async () => {
    const { executionId } = await launchWaitingChild({
      parentTurns: [
        { text: 'Parent ready.' },
        { text: 'Parent received result A.' },
        { text: 'Parent received a distinct same-text delivery.' },
      ],
      childTurns: [{ text: 'Result A.' }],
    });
    await waitForPersistedResult(executionId, 'Result A.');
    await waitForCompletedResumes(1);

    // The loop minted a stable logical identity for turn 1's delivery.
    const store = getExecutionStore(executionId);
    const turnState = await store.readTurnState();
    expect(turnState?.activeTurn).toBeUndefined();
    const completed = turnState?.lastCompletedTurn;
    expect(completed?.token).toBeTruthy();
    await expect(store.readResultMeta()).resolves.toMatchObject({
      turnToken: completed!.token,
    });

    // Replay the identical logical delivery 100 times through the real
    // admission path: no additional parent message, no additional wake.
    const report = await store.readReport();
    for (let replay = 0; replay < 100; replay++) {
      await deliverChildRunFollowUp({
        targetStreamId: PARENT_STREAM_ID,
        followUp: {
          text: report!,
          origin: 'subagent_result',
          deliveryId: completed!.deliveryId,
        },
        session,
      });
    }
    await session.transcripts.flush();
    const afterReplay = JSON.stringify(
      (await readCompletedRunConversation(PARENT_EXECUTION_ID)).conversation,
    );
    expect(afterReplay.match(/Result A\./g)).toHaveLength(1);
    expect(resumedStreams).toEqual([PARENT_STREAM_ID]);
    expect(completedResumes).toEqual([PARENT_STREAM_ID]);

    // A distinct delivery identity with identical text is a distinct turn.
    await deliverChildRunFollowUp({
      targetStreamId: PARENT_STREAM_ID,
      followUp: {
        text: report!,
        origin: 'subagent_result',
        deliveryId: `${completed!.deliveryId}:other`,
      },
      session,
    });
    await waitForCompletedResumes(2);
    await session.transcripts.flush();
    const afterDistinct = JSON.stringify(
      (await readCompletedRunConversation(PARENT_EXECUTION_ID)).conversation,
    );
    expect(afterDistinct.match(/Result A\./g)).toHaveLength(2);
    expect(resumedStreams).toEqual([PARENT_STREAM_ID, PARENT_STREAM_ID]);
  }, 30_000);

  it('does not expose turn 1 as current when an accepted turn 2 is interrupted', async () => {
    let releaseTurn2: (err: unknown) => void = () => {};
    const turn2Gate = new Promise<never>((_, reject) => {
      releaseTurn2 = reject;
    });
    void turn2Gate.catch(() => {});
    const { executionId, parentContext, runAsParentOwner } =
      await launchWaitingChild({
        parentTurns: [
          { text: 'Parent ready.' },
          { text: 'Parent received result A.' },
        ],
        childTurns: [{ text: 'Result A.' }, 'hang'],
        childGate: turn2Gate,
      });
    await waitForPersistedResult(executionId, 'Result A.');
    await waitForCompletedResumes(1);

    const store = getExecutionStore(executionId);
    const completed1 = (await store.readTurnState())?.lastCompletedTurn;
    expect(completed1?.token).toBeTruthy();

    // Accept a follow-up: the loop runs turn 2, which hangs mid-model-call.
    await queueSecondAssertionFollowUp(
      parentContext,
      runAsParentOwner,
      executionId,
    );

    // Turn 2 was accepted: a pending-turn record marks it active, while the
    // persisted result still belongs to the latest completed turn (turn 1).
    await vi.waitFor(
      async () => {
        const state = await store.readTurnState();
        expect(state?.activeTurn?.token).toBeTruthy();
        expect(state?.activeTurn?.token).not.toBe(completed1!.token);
        expect(state?.lastCompletedTurn?.token).toBe(completed1!.token);
      },
      { timeout: 10_000 },
    );
    await expect(store.readResultMeta()).resolves.toMatchObject({
      turnToken: completed1!.token,
      result: { response: 'Result A.' },
    });

    // Interrupt turn 2 before it persists any result.
    for (const activeId of session.executions.getActiveIds()) {
      const handle = session.executions.getHandle(activeId);
      if (handle instanceof AgentExecutionHandle) handle.interrupt();
    }
    releaseTurn2(new Error('interrupted before result persistence'));
    await waitForOwnedExecutionLeaseRelease(executionId);

    // Turn 1 stays the latest completed turn; turn 2 remains on record as
    // the interrupted active turn instead of turn 1 posing as current.
    const finalState = await store.readTurnState();
    expect(finalState?.lastCompletedTurn?.token).toBe(completed1!.token);
    expect(finalState?.activeTurn?.token).toBeTruthy();
    await expect(store.readResultMeta()).resolves.toMatchObject({
      turnToken: completed1!.token,
      result: { response: 'Result A.', outcome: RUN_OUTCOME.CANCELLED },
    });

    // /report and /result distinguish the interrupted turn from the latest
    // completed one.
    const reportView = await new ExecutionsTool().call({
      path: `/executions/${executionId}/report`,
    });
    expect(reportView.status).toBe('executed');
    expect(reportView.output).toContain('Result A.');
    expect(reportView.output).toContain('interrupted');
    const resultView = await new ExecutionsTool().call({
      path: `/executions/${executionId}/result`,
    });
    expect(resultView.status).toBe('executed');
    // /result is the machine-readable chaining endpoint: the attribution
    // rides inside the JSON, never as prefixed prose.
    if (!resultView.output) throw new Error('expected /result output');
    const parsed = JSON.parse(resultView.output);
    expect(parsed.turnAttribution).toContain('interrupted');
    expect(parsed.response).toBe('Result A.');
  }, 30_000);
});

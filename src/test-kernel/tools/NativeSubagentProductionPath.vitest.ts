import { Effect, Stream } from 'effect';
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

const modelBindingMocks = vi.hoisted(() => ({
  bindModel: vi.fn(),
}));

vi.mock('@agent/runtime/run/modelBinding', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/run/modelBinding')>()),
  bindModel: modelBindingMocks.bindModel,
}));

// Local imports - agent runtime
import { registerInlineAgents } from '@agent/index';
import {
  clearStoreCache,
  getRunStore,
  getRunRecords,
  registerRun,
} from '@agent/storage';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { clearInlineAgents } from '@agent/index/agentRegistry';
import {
  assertOwnedRunLease,
  ownsRunLease,
  releaseOwnedRunLease,
} from '@agent/storage/runLease';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { RunHandle } from '@agent/runtime/RunHandle';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import type { Message } from '@agent/runtime/loop/rows';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { executeAgent } from '@agent/runtime/executeAgent';
import { resumeRun } from '@agent/runtime/resumeRun';
import {
  initializeDefaultSession,
  teardownDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';

// Local imports - shared/runtime boundaries
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import {
  ModelError,
  ResolvedTurnSchema,
  TurnResultSchema,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from '@llm/turn';
import { effectRuntime } from '@platform/processRuntime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { Platform } from '@platform/platform';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { setupPlatform, type FakeHost } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import { executeSubagent } from '@tools/delegation/subagentRun';
import { readCompletedRunConversation } from '@transcript';

const PARENT_RUN_ID = 'a9531a9531a9' as RunId;
const OUTER_RUN_ID = '0a95310a9531' as RunId;
const PARENT_AGENT = 'parent_9531';
const CHILD_AGENT = 'child_9531';
const PARENT_MODEL = 'gpt54';
const CHILD_MODEL = 'gpt55';

const tempDirs = useTempDirs();
let session: SessionHandle;
let childId: RunId | undefined;
let resumedRuns: RunId[];
let completedResumes: RunId[];

interface ScriptedTurn {
  readonly text: string;
}

/** The http arm of a binding: `identified` events carry no editor origin. */
type HttpOrigin = Exclude<ModelOrigin, { protocol: 'vscode-lm' }>;

/**
 * The transport stub: one `Model` per registry name, serving one scripted
 * turn per invocation. The loop calls `prepareTurn` then `streamTurn`, so
 * those two are the whole provider surface this fixture has to script.
 */
function scriptedOrigin(model: string): HttpOrigin {
  return {
    protocol: 'openai-chat',
    codecVersion: 1,
    requestedModel: model,
    deployment: {
      endpoint: 'https://api.example.test/v1',
      credentialScope: 'openai',
    },
  };
}

function preparedTurn(origin: ModelOrigin): ResolvedTurn {
  return ResolvedTurnSchema.parse({
    ...origin,
    mode: 'foreground',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
    tools: [],
    controls: {
      temperature: null,
      maxOutputTokens: 1024,
      parallelToolCalls: false,
      toolChoice: 'auto',
      effort: null,
    },
  });
}

/**
 * An answerless turn carries no content at all: the scripted transport ends
 * the turn without an assistant message rather than with an empty one.
 */
function scriptedResult(origin: ModelOrigin, text: string): TurnResult {
  return TurnResultSchema.parse({
    kind: 'http',
    providerResponseId: `resp-${origin.requestedModel}-${text.length}`,
    requestedOrigin: origin,
    returnedModel: null,
    modelFingerprint: null,
    content:
      text === ''
        ? []
        : [{ kind: 'message', content: [{ kind: 'text', text }] }],
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  });
}

/** One request the transport was asked to prepare, as the loop assembled it. */
interface ObservedRequest {
  readonly model: string;
  readonly messages: readonly Message[];
}

/** The text one canonical message carries, whatever role wrote it. */
function messageText(message: Message): string {
  switch (message.role) {
    case 'user':
      return message.content
        .map((part) => (part.kind === 'text' ? part.text : ''))
        .join('');
    case 'assistant':
      return message.content
        .flatMap((part) =>
          part.kind === 'message'
            ? part.content.map((piece) => piece.text)
            : [],
        )
        .join('');
    case 'tool':
      return message.results
        .flatMap((result) =>
          result.content.map((part) => (part.kind === 'text' ? part.text : '')),
        )
        .join('');
  }
}

function scriptedBoundModel(
  config: BoundModel['config'],
  turns: Array<ScriptedTurn | 'hang'>,
  observed: ObservedRequest[],
  hangGate?: Promise<unknown>,
): BoundModel {
  const origin = scriptedOrigin(config.fullName);
  const model: Model = {
    prepareTurn: (request) => {
      observed.push({ model: config.name, messages: request.messages });
      return Effect.succeed(preparedTurn(origin));
    },
    streamTurn: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const turn = turns.shift();
          if (turn === 'hang') {
            yield* Effect.tryPromise({
              try: () => hangGate ?? new Promise(() => {}),
              catch: (cause) =>
                new ModelError({
                  kind: 'transport',
                  message: 'Scripted hang released.',
                  cause,
                }),
            });
            return Stream.empty;
          }
          if (!turn) {
            return Stream.fail(
              new ModelError({
                kind: 'transport',
                message: `Unexpected ${config.name} model invocation.`,
              }),
            );
          }
          const events: TurnEvent[] = [
            {
              kind: 'identified',
              providerResponseId: `resp-${config.name}`,
              requestedOrigin: origin,
              returnedModel: null,
            },
            { kind: 'completed', result: scriptedResult(origin, turn.text) },
          ];
          return Stream.fromIterable(events);
        }),
      ),
    generateTurn: () =>
      Effect.die(new Error('The run loops stream; they never generate.')),
  };
  return {
    modelId: config.name,
    config,
    compatibilityKey: 'OpenAI',
    model,
    origin,
    usageProvider: 'openai',
    usageRoute: 'api-key',
    contextWindow: config.contextWindow,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsReasoning: false,
    supportsForcedToolChoice: true,
    wireRouteKey: JSON.stringify(['openai', 'api-key', config.fullName]),
    modelRetryRouteKey: JSON.stringify([
      'openai',
      'api-key',
      config.fullName,
      config.name,
    ]),
    routedOnKimiCode: false,
    backgroundCapable: false,
  };
}

async function resumePersistedRun(
  runId: RunId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  resumedRuns.push(runId);
  const resumed = await effectRuntime().runPromise(
    resumeRun(runId, {
      session,
      recovery,
      executeWorkflow: async () => {
        throw new Error('Workflow resume is not part of this fixture.');
      },
    }),
  );
  completedResumes.push(runId);
  return 'started' in resumed && resumed.delivered;
}

async function integrationPlatform(): Promise<FakeHost> {
  const host = await createTempDirPlatform('texra-9531-production-', tempDirs);
  return {
    ...host,
    platform: {
      ...host.platform,
      agentResume: { tryResumeRun: resumePersistedRun },
    },
  };
}

function inlineAgent(name: string) {
  return {
    name,
    description: `Integration fixture ${name}.`,
    settings: { agentCategory: AgentCategory.ToolUse, tools: [] },
    // The loop builds the opening user message from the agent's prompts, so
    // the fixture carries a real request template rather than a transport
    // override that skipped prompt construction.
    prompts: {
      systemPrompt: `You are ${name}.`,
      userRequest: '{{ INSTRUCTION }}',
    },
  };
}

async function waitForPersistedResult(
  runId: RunId,
  expectedText: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const report = await Effect.runPromise(
        getRunRecords(session, runId).readReport(),
      );
      expect(report).toContain(expectedText);
      await expect(
        Effect.runPromise(getRunRecords(session, runId).readResultMeta()),
      ).resolves.toMatchObject({
        output: { response: expectedText },
      });
    },
    { timeout: 20_000 },
  );
}

function childRunId(resultOutput: string | undefined): RunId {
  const match = resultOutput?.match(/Run ID: (\S+)/);
  if (!match?.[1]) throw new Error('Delegation result omitted its run ID.');
  return match[1] as RunId;
}

function interruptActiveRuns(session: SessionHandle): void {
  for (const runId of session.runs.getActiveIds()) {
    const handle = session.runs.getHandle(runId);
    if (handle instanceof RunHandle) handle.interrupt();
  }
}

async function waitForCompletedResumes(count: number): Promise<void> {
  await vi.waitFor(() => expect(completedResumes).toHaveLength(count), {
    timeout: 10_000,
  });
}

type ParentOwnerRunner = <T>(operation: () => T) => T;

/**
 * Wait for the child's lease release. The loop's lane stays held past that
 * point while its final delivery wakes the parent, so the lease, not the
 * lane, is the durable boundary these assertions read against.
 */
function waitForLeaseRelease(runId: RunId): Promise<void> {
  return vi.waitFor(() => expect(ownsRunLease(runId)).toBe(false));
}

/**
 * Queue the second-assertion follow-up onto a WAITING child through the real
 * DelegateAgentTool path, asserting the queue accepted it.
 */
async function queueSecondAssertionFollowUp(
  parentContext: ReturnType<typeof createRunContext>,
  runAsParentOwner: ParentOwnerRunner,
  runId: RunId,
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
        execution_id: runId,
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
  readonly runId: RunId;
  readonly parentContext: ReturnType<typeof createRunContext>;
  readonly runAsParentOwner: ParentOwnerRunner;
  readonly observedRequests: ObservedRequest[];
}> {
  const observedRequests: ObservedRequest[] = [];
  modelBindingMocks.bindModel.mockImplementation(
    (input: { readonly config: BoundModel['config'] }) =>
      Effect.succeed(
        scriptedBoundModel(
          input.config,
          input.config.name === CHILD_MODEL
            ? options.childTurns
            : options.parentTurns,
          observedRequests,
          options.childGate,
        ),
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
  await Effect.runPromise(
    registerRun(session, PARENT_RUN_ID, parentConfig, PARENT_AGENT, {
      identity: { kind: 'agent', agent: PARENT_AGENT },
      parentRunId: OUTER_RUN_ID,
    }),
  );
  await expect(
    effectRuntime().runPromise(
      prepareAgentDefinition({ config: parentConfig, session }).pipe(
        Effect.flatMap((definition) =>
          executeAgent(definition, PARENT_RUN_ID, {
            session,
            parentRunId: OUTER_RUN_ID,
          }),
        ),
      ),
    ),
  ).resolves.toMatchObject({
    outcome: RUN_PHASE.WAITING,
    output: { response: 'Parent ready.' },
  });

  const parentContext = createRunContext({
    runId: PARENT_RUN_ID,
    config: { model: PARENT_MODEL },
    session,
  });
  const runAsParentOwner: ParentOwnerRunner = (operation) => {
    assertOwnedRunLease(PARENT_RUN_ID);
    return operation();
  };
  const launch = await runAsParentOwner(() =>
    withRunContext(parentContext, () =>
      effectRuntime().runPromise(
        executeSubagent(
          parentContext,
          undefined,
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
          PARENT_RUN_ID,
        ),
      ),
    ),
  );
  expect(launch.status).toBe('executed');
  const runId = childRunId(launch.output);
  childId = runId;
  return { runId, parentContext, runAsParentOwner, observedRequests };
}

describe('native subagent production delivery path', { retry: 2 }, () => {
  setupPlatform(integrationPlatform);

  beforeEach(async () => {
    clearStoreCache();
    clearInlineAgents();
    registerInlineAgents([inlineAgent(PARENT_AGENT), inlineAgent(CHILD_AGENT)]);
    // The process session over a persistent store: one session per root,
    // so the ephemeral default this file's setup installed gives way to it.
    teardownDefaultSession();
    session = initializeDefaultSession({});
    publishTestRunStart(session, OUTER_RUN_ID);
    await session.settlePublications();
    childId = undefined;
    resumedRuns = [];
    completedResumes = [];
  });

  afterEach(async () => {
    interruptActiveRuns(session);
    if (childId) await waitForLeaseRelease(childId);
    await releaseOwnedRunLease(PARENT_RUN_ID);
    teardownDefaultSession();
    clearInlineAgents();
    clearStoreCache();
    vi.restoreAllMocks();
  });

  it('resumes one persisted child through the real queue and archives both turns once', async () => {
    const parentTurns = [
      { text: 'Parent ready.' },
      { text: 'Parent received result A.' },
      { text: 'Parent received result B.' },
    ];
    const childTurns = [{ text: 'Result A.' }, { text: 'Result B.' }];
    const { runId, parentContext, runAsParentOwner, observedRequests } =
      await launchWaitingChild({ parentTurns, childTurns });

    await waitForPersistedResult(runId, 'Result A.');
    await waitForCompletedResumes(1);

    const resumed = await queueSecondAssertionFollowUp(
      parentContext,
      runAsParentOwner,
      runId,
    );
    expect(resumed.summary).toContain('Follow-up queued');

    await waitForPersistedResult(runId, 'Result B.');
    await waitForCompletedResumes(2);

    // The resumed turn asks the model with the follow-up as its last message
    // and turn 1's answer still in the history it carries.
    const childResumeRequest = observedRequests.find(({ model, messages }) => {
      const last = messages.at(-1);
      return (
        model === CHILD_MODEL &&
        last !== undefined &&
        messageText(last).includes('second assertion')
      );
    });
    expect(childResumeRequest?.messages.map(messageText)).toContain(
      'Result A.',
    );

    await session.settlePublications();
    const archivedChild = await Effect.runPromise(
      readCompletedRunConversation(runId, session),
    );
    expect(archivedChild.conversation).toEqual([
      expect.objectContaining({ kind: 'user-message' }),
      { kind: 'assistant-text', text: 'Result A.' },
      {
        kind: 'user-message',
        parts: [
          { type: 'text', text: expect.stringContaining('second assertion') },
        ],
      },
      { kind: 'assistant-text', text: 'Result B.' },
    ]);

    const archivedParent = await Effect.runPromise(
      readCompletedRunConversation(PARENT_RUN_ID, session),
    );
    const parentText = JSON.stringify(archivedParent.conversation);
    expect(parentText.match(/Result A\./g)).toHaveLength(1);
    expect(parentText.match(/Result B\./g)).toHaveLength(1);
    expect(archivedParent.conversation).toEqual(
      expect.arrayContaining([
        { kind: 'assistant-text', text: 'Parent received result A.' },
        { kind: 'assistant-text', text: 'Parent received result B.' },
      ]),
    );
    expect(resumedRuns).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
    expect(completedResumes).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
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
    const { runId, parentContext, runAsParentOwner } = await launchWaitingChild(
      { parentTurns, childTurns },
    );

    await waitForPersistedResult(runId, 'Result A.');
    await waitForCompletedResumes(1);

    const resumed = await queueSecondAssertionFollowUp(
      parentContext,
      runAsParentOwner,
      runId,
    );
    expect(resumed.summary).toContain('Follow-up queued');

    // The answerless turn still delivers: its report/result overwrite turn 1's
    // with an explicitly empty response rather than replaying 'Result A.' — and
    // the parent is resumed a second time to consume that empty delivery.
    await vi.waitFor(
      async () => {
        await expect(
          Effect.runPromise(getRunRecords(session, runId).readResultMeta()),
        ).resolves.toMatchObject({
          output: { response: '' },
        });
        const report = await Effect.runPromise(
          getRunRecords(session, runId).readReport(),
        );
        expect(report).not.toContain('Result A.');
        expect(report).not.toContain('<response>');
      },
      { timeout: 10_000 },
    );
    await waitForCompletedResumes(2);

    await session.settlePublications();
    const archivedChild = await Effect.runPromise(
      readCompletedRunConversation(runId, session),
    );
    // Turn 2 added the user instruction but no new assistant row.
    expect(archivedChild.conversation).toEqual([
      expect.objectContaining({ kind: 'user-message' }),
      { kind: 'assistant-text', text: 'Result A.' },
      {
        kind: 'user-message',
        parts: [
          { type: 'text', text: expect.stringContaining('second assertion') },
        ],
      },
    ]);

    const archivedParent = await Effect.runPromise(
      readCompletedRunConversation(PARENT_RUN_ID, session),
    );
    const parentText = JSON.stringify(archivedParent.conversation);
    expect(parentText.match(/Result A\./g)).toHaveLength(1);
    expect(resumedRuns).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
    expect(completedResumes).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
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
    const { runId, parentContext, runAsParentOwner } = await launchWaitingChild(
      { parentTurns, childTurns },
    );

    await waitForPersistedResult(runId, 'Result A.');
    await waitForCompletedResumes(1);

    // Submit two follow-ups concurrently, before the child drains the queue.
    // The loop drains the follow-up batch (waitAndDrainAll) and runs one turn
    // with the combined batch, so both instructions reach the child in one
    // ordered turn rather than sharing/overwriting one turn result.
    const [first, second] = await Promise.all([
      queueSecondAssertionFollowUp(
        parentContext,
        runAsParentOwner,
        runId,
        'Now prove the second assertion.',
      ),
      queueSecondAssertionFollowUp(
        parentContext,
        runAsParentOwner,
        runId,
        'Now prove the third assertion.',
      ),
    ]);
    expect(first.status).toBe('executed');
    expect(second.status).toBe('executed');

    await waitForPersistedResult(runId, 'Result B.');
    await waitForCompletedResumes(2);

    // The child transcript has turn 1 (Result A) and the batch turn (Result B),
    // with BOTH follow-up instructions recorded as user messages in the batch.
    await session.settlePublications();
    const archivedChild = await Effect.runPromise(
      readCompletedRunConversation(runId, session),
    );
    const childText = JSON.stringify(archivedChild.conversation);
    expect(childText.match(/Result A\./g)).toHaveLength(1);
    expect(childText.match(/Result B\./g)).toHaveLength(1);
    expect(childText).toContain('second assertion');
    expect(childText).toContain('third assertion');

    // The parent received each distinct result exactly once.
    const archivedParent = await Effect.runPromise(
      readCompletedRunConversation(PARENT_RUN_ID, session),
    );
    const parentText = JSON.stringify(archivedParent.conversation);
    expect(parentText.match(/Result A\./g)).toHaveLength(1);
    expect(parentText.match(/Result B\./g)).toHaveLength(1);
    expect(resumedRuns).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
    expect(completedResumes).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
    expect(parentTurns).toHaveLength(0);
  }, 60_000);

  it('suppresses replays of one logical child delivery at the real admission boundary', async () => {
    const { runId } = await launchWaitingChild({
      parentTurns: [
        { text: 'Parent ready.' },
        { text: 'Parent received result A.' },
        { text: 'Parent received a distinct same-text delivery.' },
      ],
      childTurns: [{ text: 'Result A.' }],
    });
    await waitForPersistedResult(runId, 'Result A.');
    await waitForCompletedResumes(1);

    // The loop minted a stable logical identity for turn 1's delivery.
    const store = getRunStore(runId);
    const turnState = await store.readTurnState();
    expect(turnState?.activeTurn).toBeUndefined();
    const completed = turnState?.lastCompletedTurn;
    expect(completed?.token).toBeTruthy();
    await expect(
      Effect.runPromise(getRunRecords(session, runId).readResultMeta()),
    ).resolves.toMatchObject({
      turnToken: completed!.token,
    });

    // Replay the identical logical delivery 100 times through the real
    // admission path: no additional parent message, no additional wake.
    const report = await Effect.runPromise(
      getRunRecords(session, runId).readReport(),
    );
    for (let replay = 0; replay < 100; replay++) {
      await Effect.runPromise(
        submitFollowUp(
          PARENT_RUN_ID,
          {
            text: report!,
            origin: 'subagent_result',
            // Derived from the persisted turn token exactly as production does.
            deliveryId: `${completed!.token}:delivery`,
          },
          { session },
        ),
      );
    }
    await session.settlePublications();
    const afterReplay = JSON.stringify(
      (
        await Effect.runPromise(
          readCompletedRunConversation(PARENT_RUN_ID, session),
        )
      ).conversation,
    );
    expect(afterReplay.match(/Result A\./g)).toHaveLength(1);
    expect(resumedRuns).toEqual([PARENT_RUN_ID]);
    expect(completedResumes).toEqual([PARENT_RUN_ID]);

    // A distinct delivery identity with identical text is a distinct turn.
    await Effect.runPromise(
      submitFollowUp(
        PARENT_RUN_ID,
        {
          text: report!,
          origin: 'subagent_result',
          deliveryId: `${completed!.token}:delivery:other`,
        },
        { session },
      ),
    );
    await waitForCompletedResumes(2);
    await session.settlePublications();
    const afterDistinct = JSON.stringify(
      (
        await Effect.runPromise(
          readCompletedRunConversation(PARENT_RUN_ID, session),
        )
      ).conversation,
    );
    expect(afterDistinct.match(/Result A\./g)).toHaveLength(2);
    expect(resumedRuns).toEqual([PARENT_RUN_ID, PARENT_RUN_ID]);
  }, 30_000);

  it('does not expose turn 1 as current when an accepted turn 2 is interrupted', async () => {
    let releaseTurn2: (err: unknown) => void = () => {};
    const turn2Gate = new Promise<never>((_, reject) => {
      releaseTurn2 = reject;
    });
    void turn2Gate.catch(() => {});
    const { runId, parentContext, runAsParentOwner } = await launchWaitingChild(
      {
        parentTurns: [
          { text: 'Parent ready.' },
          { text: 'Parent received result A.' },
        ],
        childTurns: [{ text: 'Result A.' }, 'hang'],
        childGate: turn2Gate,
      },
    );
    await waitForPersistedResult(runId, 'Result A.');
    await waitForCompletedResumes(1);

    const store = getRunStore(runId);
    const completed1 = (await store.readTurnState())?.lastCompletedTurn;
    expect(completed1?.token).toBeTruthy();

    // Accept a follow-up: the loop runs turn 2, which hangs mid-model-call.
    await queueSecondAssertionFollowUp(parentContext, runAsParentOwner, runId);

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
    await expect(
      Effect.runPromise(getRunRecords(session, runId).readResultMeta()),
    ).resolves.toMatchObject({
      turnToken: completed1!.token,
      output: { response: 'Result A.' },
    });

    // Stop the child before turn 2 persists any result. The registry stop
    // reaches the loop as well as the turn, so the turn is interrupted rather
    // than delivered as a cancelled completion.
    const stopped = session.runs.kill(runId);
    expect(stopped.accepted).toBe(true);
    const stopSettlement = Effect.runPromise(stopped.settlement);
    releaseTurn2(new Error('interrupted before result persistence'));
    await stopSettlement;
    await waitForLeaseRelease(runId);

    // Turn 1 stays the latest completed turn; turn 2 remains on record as
    // the interrupted active turn instead of turn 1 posing as current.
    const finalState = await store.readTurnState();
    expect(finalState?.lastCompletedTurn?.token).toBe(completed1!.token);
    expect(finalState?.activeTurn?.token).toBeTruthy();
    await expect(
      Effect.runPromise(getRunRecords(session, runId).readResultMeta()),
    ).resolves.toMatchObject({
      turnToken: completed1!.token,
      output: { response: 'Result A.' },
    });
    // How the run ended is the `run.end` row's fact, not the manifest's: the
    // stop cancelled the run while turn 1's output stands as its latest.
    await expect(
      Effect.runPromise(getRunRecords(session, runId).readRunEnd()),
    ).resolves.toMatchObject({ outcome: RUN_OUTCOME.CANCELLED });

    // /report and /result distinguish the interrupted turn from the latest
    // completed one.
    const reportView = await new ExecutionsTool().call({
      path: `/executions/${runId}/report`,
    });
    expect(reportView.status).toBe('executed');
    expect(reportView.output).toContain('Result A.');
    expect(reportView.output).toContain('interrupted');
    const resultView = await new ExecutionsTool().call({
      path: `/executions/${runId}/result`,
    });
    expect(resultView.status).toBe('executed');
    // /result is the machine-readable chaining endpoint: the attribution
    // rides inside the JSON, never as prefixed prose.
    if (!resultView.output) throw new Error('expected /result output');
    const parsed = JSON.parse(resultView.output);
    expect(parsed.turnAttribution).toContain('interrupted');
    expect(parsed.output.response).toBe('Result A.');
  }, 30_000);
});

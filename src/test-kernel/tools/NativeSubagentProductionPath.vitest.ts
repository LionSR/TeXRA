import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Deferred, Effect, Fiber, Layer, Scope, Stream } from 'effect';

/**
 * Production-shaped regression for #9531. Agent registration, launch, child
 * looping, persisted resume, result/report writes, parent admission, recovery,
 * and transcript reopening are real. Only the external model transport is
 * replaced by the deterministic handlers below.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import {
  ModelError,
  ResolvedTurnSchema,
  TurnResultSchema,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from '@texra-ai/llm/turn';

const modelBindingMocks = vi.hoisted(() => ({
  bindModel: vi.fn(),
}));

vi.mock('@agent/runtime/run/modelBinding', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/run/modelBinding')>()),
  bindModel: modelBindingMocks.bindModel,
}));

// Local imports - agent runtime
import { refresh } from '@agent/index';
import { getRunRecords, registerRun } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import type { Message } from '@agent/runtime/loop/rows';
import { executeAgent } from '@agent/runtime/executeAgent';
import { resumeRun } from '@agent/runtime/resumeRun';
import { Runs } from '@agent/runtime/runRegistry';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import {
  initializeDefaultSession,
  teardownDefaultSession,
} from '@agent/runtime/sessionGraph';

// Local imports - shared/runtime boundaries
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import {
  AgentDirectories,
  AgentResume,
  AgentResumeFailed,
  AppState,
  type RecoveryContinuation,
} from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  nativeToolTestLayer,
  emptyPinnedComposition,
  testModelCell,
} from '@test/support/nativeToolTestLayer';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  fakeHostAgentDirectories,
  fakeHostAgentResume,
  setupPlatform,
  type FakeHost,
} from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
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
let parentFiber: Fiber.Fiber<unknown, Error> | undefined;
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
  let progressOnly = false;
  const model: Model = {
    prepareTurn: (request) => {
      const latest = request.messages.at(-1);
      const text = latest ? messageText(latest) : '';
      progressOnly =
        config.name === PARENT_MODEL &&
        text.includes('<subagent-progress') &&
        !text.includes('<subagent-result');
      observed.push({ model: config.name, messages: request.messages });
      return Effect.succeed(preparedTurn(origin));
    },
    streamTurn: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const turn = progressOnly
            ? { text: 'Parent noted progress.' }
            : turns.shift();
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
    usageRoute: 'api-key',
    contextWindow: config.contextWindow,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: true,
    wireRouteKey: JSON.stringify(['openai', 'api-key', config.fullName]),
    modelRetryRouteKey: JSON.stringify([
      'openai',
      'api-key',
      config.fullName,
      config.name,
    ]),
    backgroundCapable: false,
  };
}

function resumePersistedRun(
  runId: RunId,
  recovery?: RecoveryContinuation,
): Effect.Effect<boolean, AgentResumeFailed> {
  // The port's contract, not convenience: the fixture answers with the
  // program the port declares, and records its ordering inside it.
  return Effect.tryPromise({
    try: async () => {
      resumedRuns.push(runId);
      const resumed = await testRuntime().runPromise(
        resumeRun(runId, {
          session,
          recovery,
          executeWorkflow: () =>
            Effect.fail(
              new Error('Workflow resume is not part of this fixture.'),
            ),
        }),
      );
      return 'started' in resumed && resumed.delivered;
    },
    catch: (cause) =>
      new AgentResumeFailed({
        runId,
        message: 'Fixture resume failed.',
        cause,
      }),
  });
}

async function integrationPlatform(): Promise<FakeHost> {
  const host = await createTempDirPlatform('texra-9531-production-', tempDirs);
  const agentsDir = await makeTempDir('texra-9531-agents-', tempDirs);
  await Promise.all(
    [PARENT_AGENT, CHILD_AGENT].map((name) =>
      writeFile(path.join(agentsDir, `${name}.yaml`), agentYaml(name)),
    ),
  );
  return {
    ...host,
    agentResume: { tryResumeRun: resumePersistedRun },
    platform: {
      ...host.platform,
      agentDirectories: {
        custom: () => Effect.sync(() => agentsDir),
        customConfigured: () => Effect.succeed(false),
        builtIn: () => Effect.sync(() => agentsDir),
        builtInToolUse: () => Effect.sync(() => agentsDir),
      },
    },
  };
}

function agentYaml(name: string): string {
  return [
    `name: ${name}`,
    `description: Integration fixture ${name}.`,
    'settings:',
    '  agentCategory: toolUse',
    '  tools: []',
    // The loop builds the opening user message from the agent's prompts, so
    // the fixture carries a real request template rather than a transport
    // override that skipped prompt construction.
    'prompts:',
    `  systemPrompt: You are ${name}.`,
    "  userRequest: '{{ INSTRUCTION }}'",
    '',
  ].join('\n');
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
    session.runs.interrupt(runId);
  }
}

function waitForParentTurns(count: number): Effect.Effect<void> {
  return Effect.promise(() =>
    vi.waitFor(
      async () => {
        await Effect.runPromise(session.settlePublications(PARENT_RUN_ID));
        const transcript = await Effect.runPromise(
          readCompletedRunConversation(PARENT_RUN_ID, session),
        );
        expect(
          transcript.conversation?.filter(
            (row) =>
              row.kind === 'assistant-text' &&
              row.text !== 'Parent noted progress.',
          ),
        ).toHaveLength(count + 1);
        expect(session.runView(PARENT_RUN_ID)?.status).toBe(RUN_PHASE.WAITING);
      },
      { timeout: 20_000 },
    ),
  );
}

/**
 * Wait for the child's claim release. The loop's lane stays held past that
 * point while its final delivery wakes the parent, so the claim, not the
 * lane, is the durable boundary these assertions read against.
 */
function waitForClaimRelease(runId: RunId): Promise<void> {
  return vi.waitFor(async () => {
    expect(await Effect.runPromise(session.ownsRun(runId))).toBe(false);
  });
}

/**
 * What a follow-up dispatch needs off the parent run: the explicit carriers
 * the delegation tool reads (run identity, owning session, current model).
 */
interface ParentDelegationContext {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly model: string;
}

/**
 * Queue the second-assertion follow-up onto a WAITING child through the real
 * DelegateAgentTool path, asserting the queue accepted it.
 */
async function queueSecondAssertionFollowUp(
  parentContext: ParentDelegationContext,
  runId: RunId,
  instruction = 'Now prove the second assertion.',
) {
  const resumed = await testRuntime().runPromise(
    DelegateAgentTool.call({
      agent: null,
      model: null,
      instruction,
      memories: [],
      working_directory: null,
      execution_id: runId,
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          tracker: new FileInteractionState(),
          run: {
            runId: parentContext.runId,
            session: parentContext.session,
            config: AgentConfigSchema.parse({
              agent: 'chat',
              model: parentContext.model,
            }),
            toolPolicy: {},
          },
        }),
      ),
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
  readonly parentContext: ParentDelegationContext;
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
    agentSource: 'custom',
    agentCategory: AgentCategory.ToolUse,
    model: PARENT_MODEL,
    instruction: 'Coordinate the child proof review.',
    workingDirectory: process.cwd(),
  });
  await Effect.runPromise(
    registerRun(session, PARENT_RUN_ID, parentConfig, {
      identity: { kind: 'agent', agent: PARENT_AGENT },
      parentRunId: OUTER_RUN_ID,
    }),
  );
  // Admitted on the run's lane like every production launch, so the run's
  // fiber is its stop target by run id.
  parentFiber = testRuntime().runFork(
    session.runs.launchRun(
      PARENT_RUN_ID,
      prepareAgentDefinition({ config: parentConfig, session }).pipe(
        Effect.flatMap((definition) =>
          executeAgent(definition, PARENT_RUN_ID, {
            session,
            parentRunId: OUTER_RUN_ID,
          }),
        ),
      ),
    ),
  );
  await Effect.runPromise(waitForParentTurns(0));

  const parentContext: ParentDelegationContext = {
    runId: PARENT_RUN_ID,
    session,
    model: PARENT_MODEL,
  };
  const parentCall = {
    roots: session.roots,
    tracker: new FileInteractionState(),
    workingDirectory: process.cwd(),
    run: {
      runId: PARENT_RUN_ID,
      session,
      scope: Scope.makeUnsafe(),
      config: AgentConfigSchema.parse({
        agent: 'chat',
        model: PARENT_MODEL,
      }),
      model: testModelCell(PARENT_MODEL),
      logger: noopTrace,
      toolPolicy: {
        approvalPromptsUnavailable: false,
      },
      composition: emptyPinnedComposition,
    },
  };
  const launch = await testRuntime().runPromise(
    executeSubagent(
      parentCall,
      {
        agent: CHILD_AGENT,
        agentSource: 'custom',
        agentCategory: AgentCategory.ToolUse,
        model: CHILD_MODEL,
        instruction: 'Prove the first assertion.',
        memories: [],
        workingDirectory: process.cwd(),
      },
      CHILD_AGENT,
      PARENT_RUN_ID,
    ).pipe(Effect.provideService(Runs, session.runs)),
  );
  expect(launch.status).toBe('executed');
  const runId = childRunId(launch.output);
  childId = runId;
  return { runId, parentContext, observedRequests };
}

describe('native subagent production delivery path', { retry: 2 }, () => {
  setupPlatform(integrationPlatform);

  beforeEach(async () => {
    await Effect.runPromise(
      Effect.provide(
        refresh({ includeRemote: false }),
        Layer.mergeAll(
          unusedGlobalStorageFs(),
          nodePlatformLayer,
          testHttpClientLayer,
          AgentDirectories.layer(fakeHostAgentDirectories),
          AppState.layer(new FakeStateStore()),
        ),
      ),
    );
    // The process session over a persistent store: one session per root,
    // so the ephemeral default this file's setup installed gives way to it.
    await Effect.runPromise(teardownDefaultSession());
    session = await Effect.runPromise(
      initializeDefaultSession({ roots: testWorkspaceRoots() }),
    );
    publishTestRunStart(session, OUTER_RUN_ID);
    await Effect.runPromise(session.settlePublications());
    childId = undefined;
    resumedRuns = [];
    parentFiber = undefined;
  });

  afterEach(async () => {
    interruptActiveRuns(session);
    if (parentFiber) await Effect.runPromise(Fiber.await(parentFiber));
    if (childId) await waitForClaimRelease(childId);
    await Effect.runPromise(session.releaseRunLease(PARENT_RUN_ID));
    await Effect.runPromise(teardownDefaultSession());
    vi.restoreAllMocks();
  });

  it.live(
    'keeps one native run and model binding across both delivered turns',
    () =>
      Effect.gen(function* () {
        const parentTurns = [
          { text: 'Parent ready.' },
          { text: 'Parent received result A.' },
          { text: 'Parent received result B.' },
        ];
        const childTurns = [{ text: 'Result A.' }, { text: 'Result B.' }];
        const { runId, parentContext, observedRequests } =
          yield* Effect.promise(() =>
            launchWaitingChild({ parentTurns, childTurns }),
          );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        const firstHandle = session.runs.getHandle(runId);
        const initialBindings = modelBindingMocks.bindModel.mock.calls.length;
        yield* waitForParentTurns(1);
        const budget = yield* session.runs.childRunBudget(1);
        expect(yield* budget.takeIfAvailable(1)).toBe(true);
        yield* budget.release(1);

        const resumed = yield* Effect.promise(() =>
          queueSecondAssertionFollowUp(parentContext, runId),
        );
        expect(resumed.summary).toContain('Follow-up queued');

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result B.'));
        yield* waitForParentTurns(2);
        expect(session.runs.getHandle(runId)).toBe(firstHandle);
        expect(modelBindingMocks.bindModel).toHaveBeenCalledTimes(
          initialBindings,
        );

        // The next turn asks the model with the follow-up as its last message
        // and turn 1's answer still in the history it carries.
        const childResumeRequest = observedRequests.find(
          ({ model, messages }) => {
            const last = messages.at(-1);
            return (
              model === CHILD_MODEL &&
              last !== undefined &&
              messageText(last).includes('second assertion')
            );
          },
        );
        expect(childResumeRequest?.messages.map(messageText)).toContain(
          'Result A.',
        );

        yield* session.settlePublications();
        const archivedChild = yield* readCompletedRunConversation(
          runId,
          session,
        );
        expect(archivedChild.conversation).toEqual([
          expect.objectContaining({ kind: 'user-message' }),
          { kind: 'assistant-text', text: 'Result A.' },
          {
            kind: 'user-message',
            parts: [
              {
                type: 'text',
                text: expect.stringContaining('second assertion'),
              },
            ],
          },
          { kind: 'assistant-text', text: 'Result B.' },
        ]);

        const archivedParent = yield* readCompletedRunConversation(
          PARENT_RUN_ID,
          session,
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
        expect(resumedRuns).toEqual([]);
        expect(parentTurns).toHaveLength(0);
        yield* session.runs.kill(runId).settlement;
        yield* Effect.promise(() => waitForClaimRelease(runId));
        yield* waitForParentTurns(2);
        const afterStop = yield* readCompletedRunConversation(
          PARENT_RUN_ID,
          session,
        );
        expect(
          JSON.stringify(afterStop.conversation).match(/Result B\./g),
        ).toHaveLength(1);
        childTurns.push({ text: 'Recovered result C.' });
        parentTurns.push({ text: 'Parent received recovered result C.' });
        const recovered = yield* Effect.forkChild(
          withProcessServices(
            testRuntime(),
            resumeRun(runId, {
              session,
              extraFollowUps: [
                { text: 'Continue after restart.', origin: 'user' },
              ],
              executeWorkflow: () =>
                Effect.fail(new Error('Expected a tool-use child.')),
            }),
          ),
        );
        yield* Effect.promise(() =>
          waitForPersistedResult(runId, 'Recovered result C.'),
        );
        yield* waitForParentTurns(3);
        expect(
          yield* Fiber.join(recovered).pipe(Effect.timeout('5 seconds')),
        ).toEqual({
          started: true,
          delivered: true,
          outcome: RUN_PHASE.WAITING,
        });
        const recoveredHandle = session.runs.getHandle(runId);
        expect(recoveredHandle).toBeDefined();
        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        childTurns.push({ text: 'Recovered result D.' });
        parentTurns.push({ text: 'Parent received recovered result D.' });
        yield* submitFollowUp(runId, 'Continue in the recovered run.', {
          session,
        }).pipe(Effect.provide(AgentResume.layer(fakeHostAgentResume)));
        yield* Effect.promise(() =>
          waitForPersistedResult(runId, 'Recovered result D.'),
        );
        yield* waitForParentTurns(4);
        expect(session.runs.getHandle(runId)).toBe(recoveredHandle);
        yield* session.runs.kill(runId).settlement;
        yield* Effect.promise(() => waitForClaimRelease(runId));

        // An already idle saved run needs no new input or model turn to
        // acknowledge recovery, and its live driver still owns later input.
        expect(
          yield* withProcessServices(
            testRuntime(),
            resumeRun(runId, {
              session,
              executeWorkflow: () =>
                Effect.fail(new Error('Expected a tool-use child.')),
            }),
          ).pipe(Effect.timeout('5 seconds')),
        ).toEqual({
          started: true,
          delivered: true,
          outcome: RUN_PHASE.WAITING,
        });
        expect(session.runs.getHandle(runId)).toBeDefined();
        yield* session.viewChanges.pipe(
          Stream.filter(
            (view) => view.runs.get(runId)?.status === RUN_PHASE.WAITING,
          ),
          Stream.runHead,
          Effect.timeout('5 seconds'),
        );
        expect((yield* readChildTurnState(session, runId)).active).toBeNull();
        expect(childTurns).toHaveLength(0);
        yield* session.runs.kill(runId).settlement;
        yield* Effect.promise(() => waitForClaimRelease(runId));
        modelBindingMocks.bindModel.mockReturnValueOnce(
          Effect.fail(new Error('Recovered model binding failed.')),
        );
        parentTurns.push({ text: 'Parent received failed recovery.' });
        expect(
          yield* withProcessServices(
            testRuntime(),
            resumeRun(runId, {
              session,
              extraFollowUps: [
                { text: 'Keep this unconsumed input.', origin: 'user' },
              ],
              executeWorkflow: () =>
                Effect.fail(new Error('Expected a tool-use child.')),
            }),
          ),
        ).toEqual({
          started: true,
          delivered: false,
          outcome: RUN_OUTCOME.FAILED,
        });
        yield* waitForParentTurns(5);
      }),
    60_000,
  );

  it.live(
    'does not redeliver turn 1 when the resumed turn produces no new assistant message',
    () =>
      Effect.gen(function* () {
        const parentTurns = [
          { text: 'Parent ready.' },
          { text: 'Parent received result A.' },
          { text: 'Parent closed out an empty second turn.' },
        ];
        // Turn 2 is answerless: the scripted transport ends the turn with no text,
        // so the resumed cycle completes without adding an assistant message.
        const childTurns = [{ text: 'Result A.' }, { text: '' }];
        const { runId, parentContext } = yield* Effect.promise(() =>
          launchWaitingChild({ parentTurns, childTurns }),
        );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        yield* waitForParentTurns(1);

        const resumed = yield* Effect.promise(() =>
          queueSecondAssertionFollowUp(parentContext, runId),
        );
        expect(resumed.summary).toContain('Follow-up queued');

        // The answerless turn still delivers: its report/result overwrite turn 1's
        // with an explicitly empty response rather than replaying 'Result A.' — and
        // the parent is resumed a second time to consume that empty delivery.
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              await expect(
                Effect.runPromise(
                  getRunRecords(session, runId).readResultMeta(),
                ),
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
          ),
        );
        yield* waitForParentTurns(2);

        yield* session.settlePublications();
        const archivedChild = yield* readCompletedRunConversation(
          runId,
          session,
        );
        // Turn 2 added the user instruction but no new assistant row.
        expect(archivedChild.conversation).toEqual([
          expect.objectContaining({ kind: 'user-message' }),
          { kind: 'assistant-text', text: 'Result A.' },
          {
            kind: 'user-message',
            parts: [
              {
                type: 'text',
                text: expect.stringContaining('second assertion'),
              },
            ],
          },
        ]);

        const archivedParent = yield* readCompletedRunConversation(
          PARENT_RUN_ID,
          session,
        );
        const parentText = JSON.stringify(archivedParent.conversation);
        expect(parentText.match(/Result A\./g)).toHaveLength(1);
        expect(resumedRuns).toEqual([]);
        expect(parentTurns).toHaveLength(0);
      }),
    60_000,
  );

  it.live(
    'combines concurrent distinct follow-ups into one ordered batch turn, not an overwritten result',
    () =>
      Effect.gen(function* () {
        // Two child turns: the initial launch plus one batch turn that drains both
        // concurrent follow-ups together.
        const parentTurns = [
          { text: 'Parent ready.' },
          { text: 'Parent received result A.' },
          { text: 'Parent received result B.' },
        ];
        const childTurns = [{ text: 'Result A.' }, { text: 'Result B.' }];
        const { runId, parentContext } = yield* Effect.promise(() =>
          launchWaitingChild({ parentTurns, childTurns }),
        );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        yield* waitForParentTurns(1);

        // Submit two follow-ups concurrently, before the child drains the queue.
        // The resumed child takes the whole queued batch and runs one turn
        // with the combined batch, so both instructions reach the child in one
        // ordered turn rather than sharing/overwriting one turn result.
        const [first, second] = yield* Effect.promise(() =>
          Promise.all([
            queueSecondAssertionFollowUp(
              parentContext,
              runId,
              'Now prove the second assertion.',
            ),
            queueSecondAssertionFollowUp(
              parentContext,
              runId,
              'Now prove the third assertion.',
            ),
          ]),
        );
        expect(first.status).toBe('executed');
        expect(second.status).toBe('executed');

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result B.'));
        yield* waitForParentTurns(2);

        // The child transcript has turn 1 (Result A) and the batch turn (Result B),
        // with BOTH follow-up instructions recorded as user messages in the batch.
        yield* session.settlePublications();
        const archivedChild = yield* readCompletedRunConversation(
          runId,
          session,
        );
        const childText = JSON.stringify(archivedChild.conversation);
        expect(childText.match(/Result A\./g)).toHaveLength(1);
        expect(childText.match(/Result B\./g)).toHaveLength(1);
        expect(childText).toContain('second assertion');
        expect(childText).toContain('third assertion');

        // The parent received each distinct result exactly once.
        const archivedParent = yield* readCompletedRunConversation(
          PARENT_RUN_ID,
          session,
        );
        const parentText = JSON.stringify(archivedParent.conversation);
        expect(parentText.match(/Result A\./g)).toHaveLength(1);
        expect(parentText.match(/Result B\./g)).toHaveLength(1);
        expect(resumedRuns).toEqual([]);
        expect(parentTurns).toHaveLength(0);
      }),
    60_000,
  );

  it.live(
    'suppresses replays of one logical child delivery at the real admission boundary',
    () =>
      Effect.gen(function* () {
        const { runId } = yield* Effect.promise(() =>
          launchWaitingChild({
            parentTurns: [
              { text: 'Parent ready.' },
              { text: 'Parent received result A.' },
              { text: 'Parent received a distinct same-text delivery.' },
            ],
            childTurns: [{ text: 'Result A.' }],
          }),
        );
        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        yield* waitForParentTurns(1);

        // The loop minted a stable logical identity for turn 1's delivery.
        // The parent is admitted before the turn's settled row commits, so
        // the parent's turn can land first.
        const turnState = yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const state = await Effect.runPromise(
              readChildTurnState(session, runId),
            );
            expect(state.active).toBeNull();
            return state;
          }),
        );
        const completed = turnState.lastCompleted;
        expect(completed).not.toBeNull();
        // The delivery id the loop derives from that turn's identity.
        const deliveryId = `${runId}:${completed!.key}:${completed!.index}:delivery`;

        // Replay the identical logical delivery 100 times through the real
        // admission path: no additional parent message, no additional wake.
        const report = yield* getRunRecords(session, runId).readReport();
        for (let replay = 0; replay < 100; replay++) {
          yield* submitFollowUp(
            PARENT_RUN_ID,
            {
              text: report!,
              origin: 'subagent_result',
              deliveryId,
            },
            { session },
          ).pipe(Effect.provideService(AgentResume, fakeHostAgentResume));
        }
        yield* session.settlePublications();
        const afterReplay = JSON.stringify(
          (yield* readCompletedRunConversation(PARENT_RUN_ID, session))
            .conversation,
        );
        expect(afterReplay.match(/Result A\./g)).toHaveLength(1);
        expect(resumedRuns).toEqual([]);

        // A distinct delivery identity with identical text is a distinct turn.
        yield* submitFollowUp(
          PARENT_RUN_ID,
          {
            text: report!,
            origin: 'subagent_result',
            deliveryId: `${deliveryId}:other`,
          },
          { session },
        ).pipe(Effect.provideService(AgentResume, fakeHostAgentResume));
        yield* waitForParentTurns(2);
        yield* session.settlePublications();
        const afterDistinct = JSON.stringify(
          (yield* readCompletedRunConversation(PARENT_RUN_ID, session))
            .conversation,
        );
        expect(afterDistinct.match(/Result A\./g)).toHaveLength(2);
        expect(resumedRuns).toEqual([]);
      }),
    30_000,
  );

  it.live(
    'does not expose turn 1 as current when an accepted turn 2 is interrupted',
    () =>
      Effect.gen(function* () {
        let releaseTurn2: (err: unknown) => void = () => {};
        const turn2Gate = new Promise<never>((_, reject) => {
          releaseTurn2 = reject;
        });
        void turn2Gate.catch(() => {});
        const { runId, parentContext } = yield* Effect.promise(() =>
          launchWaitingChild({
            parentTurns: [
              { text: 'Parent ready.' },
              { text: 'Parent received result A.' },
            ],
            childTurns: [{ text: 'Result A.' }, 'hang'],
            childGate: turn2Gate,
          }),
        );
        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        yield* waitForParentTurns(1);

        // Settled after the parent's admission, so polled like the above.
        const completed1 = yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const { lastCompleted } = await Effect.runPromise(
              readChildTurnState(session, runId),
            );
            expect(lastCompleted).not.toBeNull();
            return lastCompleted;
          }),
        );

        // Accept a follow-up: the loop runs turn 2, which hangs mid-model-call.
        yield* Effect.promise(() =>
          queueSecondAssertionFollowUp(parentContext, runId),
        );

        // Turn 2 was accepted: a pending-turn record marks it active, while the
        // persisted result still belongs to the latest completed turn (turn 1).
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              const state = await Effect.runPromise(
                readChildTurnState(session, runId),
              );
              expect(state.active).not.toBeNull();
              expect(state.active).not.toEqual(completed1);
              expect(state.lastCompleted).toEqual(completed1);
            },
            { timeout: 10_000 },
          ),
        );
        expect(
          yield* getRunRecords(session, runId).readResultMeta(),
        ).toMatchObject({
          output: { response: 'Result A.' },
        });

        // Stop the child before turn 2 persists any result. The registry stop
        // reaches the loop as well as the turn, so the turn is interrupted rather
        // than delivered as a cancelled completion.
        const stopped = session.runs.kill(runId);
        expect(stopped.accepted()).toBe(true);
        const stopFiber = yield* Effect.forkChild(stopped.settlement, {
          startImmediately: true,
        });
        releaseTurn2(new Error('interrupted before result persistence'));
        yield* Fiber.join(stopFiber);
        yield* Effect.promise(() => waitForClaimRelease(runId));

        // Turn 1 stays the latest completed turn; turn 2 remains on record as
        // the interrupted active turn instead of turn 1 posing as current.
        const finalState = yield* readChildTurnState(session, runId);
        expect(finalState.lastCompleted).toEqual(completed1);
        expect(finalState.active).not.toBeNull();
        expect(
          yield* getRunRecords(session, runId).readResultMeta(),
        ).toMatchObject({
          output: { response: 'Result A.' },
        });
        // How the run ended is the `run.end` row's fact, not the manifest's: the
        // stop cancelled the run while turn 1's output stands as its latest.
        expect(yield* getRunRecords(session, runId).readRunEnd()).toMatchObject(
          { outcome: RUN_OUTCOME.CANCELLED },
        );

        // /report and /result distinguish the interrupted turn from the latest
        // completed one.
        const executionToolLayer = nativeToolTestLayer({
          run: {
            runId: PARENT_RUN_ID,
            session,
            toolPolicy: {
              approvalPromptsUnavailable: false,
            },
          },
        });
        const reportView = yield* ExecutionsTool.call({
          path: `/executions/${runId}/report`,
        }).pipe(Effect.provide(executionToolLayer));
        expect(reportView.status).toBe('executed');
        expect(reportView.output).toContain('Result A.');
        expect(reportView.output).toContain('interrupted');
        const resultView = yield* ExecutionsTool.call({
          path: `/executions/${runId}/result`,
        }).pipe(Effect.provide(executionToolLayer));
        expect(resultView.status).toBe('executed');
        // /result is the machine-readable chaining endpoint: the attribution
        // rides inside the JSON, never as prefixed prose.
        if (!resultView.output) throw new Error('expected /result output');
        const parsed = JSON.parse(resultView.output);
        expect(parsed.turnAttribution).toContain('interrupted');
        expect(parsed.output.response).toBe('Result A.');
      }),
    30_000,
  );
});

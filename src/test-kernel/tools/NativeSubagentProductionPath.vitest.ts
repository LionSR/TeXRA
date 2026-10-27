import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, Fiber, Schema, Scope, Stream } from 'effect';

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
  apiKeySecretName,
  type Model,
  ModelError,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
  TurnResultSchema,
} from '@texra-ai/llm';

const bindingMocks = vi.hoisted(() => ({
  bindModel: vi.fn(),
}));

// Every run binds its model through the scripted binder: model access is
// the one seam between a run and its provider.
vi.mock('@agent/runtime/modelAccess/ModelAccess', async (importActual) => {
  const actual =
    await importActual<
      typeof import('@agent/runtime/modelAccess/ModelAccess')
    >();
  const { Effect: E, Layer: L } = await import('effect');
  return {
    ...actual,
    modelAccessLayer: () =>
      L.succeed(actual.ModelAccess, {
        bind: (request) => bindingMocks.bindModel(request),
        admit: () => E.succeed(null),
        credentialSwitch: () => E.succeed(null),
      }),
  };
});

// Local imports - agent runtime
import { AgentCatalog } from '@agent/index/agentCatalog';
import { getRunRecords, readChildTurnState } from '@agent/storage/runRecords';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import type { Message } from '@agent/runtime/loop/rows';
import { executeAgent } from '@agent/runtime/executeAgent';
import { resumeRun } from '@agent/runtime/resumeRun';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import { type SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - shared/runtime boundaries
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import { withProcessServices } from '@platform/processRuntime';
import {
  AgentConfigSchema,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import { startAwaited } from '@test/support/runHandleFixtures';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  nativeToolTestLayer,
  noStep,
  testModelCell,
} from '@test/support/nativeToolTestLayer';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  fakeHostSecrets,
  setupPlatform,
  type FakeHost,
} from '@test/support/setupPlatform';
import {
  closeTestDefaultSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { launchDetachedSubagent } from '@tools/delegation/subagentRun';
import { readCompletedRunConversation } from '@transcript/completedRunArchive';
import { generateRunId } from '@utils/core';
import { RunFileService } from '@utils/files/runStorage';
import { ResolvedTurnSchema } from '../../../packages/llm/src/turn.js';

const PARENT_RUN_ID = 'a9531a9531a9' as RunId;
const OUTER_RUN_ID = '0a95310a9531' as RunId;
const PARENT_AGENT = 'parent_9531';
const CHILD_AGENT = 'child_9531';
const WORKFLOW_CHILD_AGENT = 'workflow_child_9531';
const PARENT_MODEL = 'openai/gpt-5.4-2026-03-05';
const CHILD_MODEL = 'openai/gpt-5.5-2026-04-23';

const tempDirs = useTempDirs();
let session: SessionHandle;
let childId: RunId | undefined;
let resumedRuns: RunId[];
let parentFiber: Fiber.Fiber<unknown, Error> | undefined;
interface ScriptedTurn {
  readonly text: string;
  /** A tool the turn calls, with no arguments, after its text. */
  readonly call?: string;
}

/**
 * The transport stub: one `Model` per registry name, serving one scripted
 * turn per invocation. The loop calls `prepareTurn` then `streamTurn`, so
 * those two are the whole provider surface this fixture has to script.
 */
function scriptedOrigin(model: string): ModelOrigin {
  return {
    protocol: 'openai-responses',
    codecVersion: 1,
    requestedModel: model,
    deployment: {
      endpoint: 'https://api.example.test/v1',
      credentialScope: 'openai',
    },
  };
}

/** The request as a Responses route prepares it: what the run records. */
function preparedTurn(origin: ModelOrigin, request: TurnRequest): ResolvedTurn {
  return Schema.decodeUnknownSync(ResolvedTurnSchema)({
    ...origin,
    mode: 'foreground',
    system: request.system,
    messages: request.messages,
    tools: request.tools ?? [],
    transport: { kind: 'http' },
    controls: {
      temperature: null,
      maxOutputTokens: 1024,
      store: false,
      parallelToolCalls: false,
      toolChoice: 'auto',
      reasoning: null,
      serviceTier: null,
    },
  });
}

/**
 * An answerless turn carries no content at all: the scripted transport ends
 * the turn without an assistant message rather than with an empty one.
 */
function scriptedResult(
  origin: ModelOrigin,
  { text, call }: ScriptedTurn,
): TurnResult {
  return Schema.decodeUnknownSync(TurnResultSchema)({
    kind: 'http',
    providerResponseId: `resp-${origin.requestedModel}-${text.length}`,
    requestedOrigin: origin,
    returnedModel: null,
    modelFingerprint: null,
    content: [
      ...(text === ''
        ? []
        : [{ kind: 'message', content: [{ kind: 'text', text }] }]),
      ...(call === undefined
        ? []
        : [
            {
              kind: 'local-call',
              providerCallId: `call-${call}`,
              name: call,
              argumentsText: '{}',
            },
          ]),
    ],
    finishReason: call === undefined ? 'stop' : 'tool-calls',
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
  /** The tool names the request offered. */
  readonly tools: readonly string[];
}

function scriptedBoundModel(
  config: BoundModel['config'],
  turns: Array<ScriptedTurn | 'hang'>,
  observed: ObservedRequest[],
  hangGate?: Promise<unknown>,
): BoundModel {
  const origin = scriptedOrigin(config.id);
  let progressOnly = false;
  const model: Model = {
    prepareTurn: (request) => {
      // Every message's text survives JSON quoting, tags included.
      const text = JSON.stringify(request.messages.at(-1) ?? '');
      progressOnly =
        config.ref === PARENT_MODEL &&
        text.includes('<subagent-progress') &&
        !text.includes('<subagent-result');
      observed.push({
        model: config.ref,
        messages: request.messages,
        tools: (request.tools ?? []).map(({ name }) => name),
      });
      return Effect.succeed(preparedTurn(origin, request));
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
                message: `Unexpected ${config.ref} model invocation.`,
              }),
            );
          }
          const events: TurnEvent[] = [
            {
              kind: 'identified',
              providerResponseId: `resp-${config.ref}`,
              requestedOrigin: origin,
              returnedModel: null,
            },
            { kind: 'completed', result: scriptedResult(origin, turn) },
          ];
          return Stream.fromIterable(events);
        }),
      ),
  };
  return {
    modelId: config.ref,
    config,
    backend: 'openai',
    model,
    origin,
    route: { kind: 'api-key', provider: 'openai', usageRoute: 'api-key' },
    forcedToolChoice: true,
    persistentConnection: false,
    billing: {},
    routes: routePolicies(['openai', 'api-key', config.id], config.ref),
    delivery: Effect.succeed('foreground'),
    automaticRetries: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    textOnly: false,
  };
}

async function integrationPlatform(): Promise<FakeHost> {
  const host = await createTempDirPlatform('texra-9531-production-', tempDirs);
  const agentsDir = await makeTempDir('texra-9531-agents-', tempDirs);
  await Promise.all([
    writeFile(
      path.join(agentsDir, `${PARENT_AGENT}.yaml`),
      agentYaml(PARENT_AGENT),
    ),
    // The child declares a tool its parent never names.
    writeFile(
      path.join(agentsDir, `${CHILD_AGENT}.yaml`),
      agentYaml(CHILD_AGENT, ['grep']),
    ),
    writeFile(
      path.join(agentsDir, `${WORKFLOW_CHILD_AGENT}.yaml`),
      workflowAgentYaml(WORKFLOW_CHILD_AGENT),
    ),
  ]);
  return {
    ...host,
    platform: {
      ...host.platform,
      agentDirectories: {
        custom: () => Effect.sync(() => agentsDir),
        customConfigured: () => Effect.succeed(false),
        builtIn: () => Effect.sync(() => agentsDir),
      },
    },
  };
}

function agentYaml(name: string, tools: readonly string[] = []): string {
  return [
    `name: ${name}`,
    `description: Integration fixture ${name}.`,
    `prompt: You are ${name}.`,
    ...(tools.length > 0 ? [`tools: [${tools.join(', ')}]`] : []),
    '',
  ].join('\n');
}

/** A one-round workflow agent: its round rewrites the input documents. */
function workflowAgentYaml(name: string): string {
  return [
    `name: ${name}`,
    `description: Integration fixture ${name}.`,
    `prompt: You are ${name}.`,
    'task:',
    '  prefix: |',
    '    <documents>',
    '    {{ ALL_INPUTS }}',
    '    </documents>',
    "  requests: ['{{ INSTRUCTION }}']",
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
  for (const runId of session.runs.get().map((run) => run.runId)) {
    registryOf(session.runs).interrupt(runId);
  }
}

function waitForParentTurns(count: number): Effect.Effect<void> {
  return Effect.promise(() =>
    vi.waitFor(
      async () => {
        await Effect.runPromise(session.log.settled);
        const transcript = await Effect.runPromise(
          readCompletedRunConversation(PARENT_RUN_ID, session),
        );
        expect(
          transcript.filter(
            (row) =>
              row.kind === 'assistant-text' &&
              row.text !== 'Parent noted progress.',
          ),
        ).toHaveLength(count + 1);
        expect(session.view.run(PARENT_RUN_ID)?.status).toBe(RUN_PHASE.WAITING);
      },
      { timeout: 20_000 },
    ),
  );
}

/** Queue a user's input on a stopped run, which the next resume reads. */
function queueRecovery(runId: RunId, text: string) {
  return Effect.asVoid(
    session.followUps.send(runId, { text, from: { kind: 'user' } }),
  );
}

/**
 * Wait for the child's claim release. The loop's lane stays held past that
 * point while its final delivery wakes the parent, so the claim, not the
 * lane, is the durable boundary these assertions read against.
 */
function waitForClaimRelease(runId: RunId): Promise<void> {
  return vi.waitFor(async () => {
    expect(await Effect.runPromise(session.log.owns(runId))).toBe(false);
  });
}

/**
 * Queue the second-assertion follow-up onto a WAITING child through the real
 * executions `send` path, from the parent run, asserting the queue accepted it.
 */
async function queueSecondAssertionFollowUp(runId: RunId) {
  const resumed = await testRuntime().runPromise(
    ExecutionsTool.call({
      path: `/executions/${runId}`,
      action: 'send',
      message: 'Now prove the second assertion.',
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            runId: PARENT_RUN_ID,
            session,
            config: Schema.decodeUnknownSync(AgentConfigSchema)({
              agent: 'chat',
              model: PARENT_MODEL,
            }),
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
  expect(resumed.status).toBe('executed');
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
  readonly observedRequests: ObservedRequest[];
}> {
  const observedRequests: ObservedRequest[] = [];
  bindingMocks.bindModel.mockImplementation(
    (input: { readonly config: BoundModel['config'] }) =>
      Effect.succeed(
        scriptedBoundModel(
          input.config,
          input.config.ref === CHILD_MODEL
            ? options.childTurns
            : options.parentTurns,
          observedRequests,
          options.childGate,
        ),
      ),
  );

  const parentConfig = Schema.decodeUnknownSync(AgentConfigSchema)({
    agent: PARENT_AGENT,
    agentSource: 'custom',
    model: PARENT_MODEL,
    instruction: 'Coordinate the child proof review.',
    workingDirectory: process.cwd(),
  });
  // Admitted on the run's lane like every production launch, so the run's
  // fiber is its stop target by run id.
  parentFiber = testRuntime().runFork(
    startAwaited(
      session.runs,
      PARENT_RUN_ID,
      prepareAgentDefinition({ config: parentConfig, session }).pipe(
        Effect.flatMap((definition) =>
          executeAgent(definition, PARENT_RUN_ID, {
            session,
            parentRunId: OUTER_RUN_ID,
            registration: {
              identity: { kind: 'agent', agent: PARENT_AGENT },
              parentRunId: OUTER_RUN_ID,
            },
          }),
        ),
      ),
    ),
  );
  await Effect.runPromise(waitForParentTurns(0));

  const parentCall = {
    callId: 'parent-call',
    env: { roots: session.roots, workingDirectory: process.cwd() },
    emit: () => undefined,
    responseId: 'parent-response',
    instruction: undefined,
    attempt: 1,
    logId: 'parent-card',
    script: null,
    scriptCalls: null,
    requests: {
      nextId: (prefix: string) => prefix,
      open: () => Effect.die(new Error('This fixture opens no request.')),
      post: () => Effect.die(new Error('This fixture posts no request.')),
      present: () => Effect.void,
    },
    run: {
      runId: PARENT_RUN_ID,
      session,
      opening: null,
      callbacks: {},
      fileService: new RunFileService(PARENT_RUN_ID, session.roots),
      scope: Scope.makeUnsafe(),
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: 'chat',
        model: PARENT_MODEL,
      }),
      model: testModelCell(PARENT_MODEL),
      logger: noopTrace,
      parentStage: noopTrace.openStage('Run: chat'),
      toolPolicy: {},
      steps: noStep(),
    },
  };
  // A direct `agent` call's launch: a fresh child id, inherited approvals.
  const launch = await testRuntime().runPromise(
    launchDetachedSubagent(
      parentCall,
      {
        agent: CHILD_AGENT,
        agentSource: 'custom',
        model: CHILD_MODEL,
        instruction: 'Prove the first assertion.',
        memories: [],
        workingDirectory: process.cwd(),
      },
      { runId: generateRunId(), grants: NO_APPROVAL_GRANTS },
    ).pipe(Effect.provideService(Runs, session.runs)),
  );
  expect(launch.status).toBe('executed');
  const runId = childRunId(launch.output);
  childId = runId;
  return { runId, observedRequests };
}

describe('native subagent production delivery path', { retry: 2 }, () => {
  setupPlatform(integrationPlatform);

  beforeEach(async () => {
    await testRuntime().runPromise(
      AgentCatalog.use((catalog) => catalog.refresh),
    );
    // The process session over a persistent store: one session per root,
    // so the ephemeral default this file's setup installed gives way to it.
    await Effect.runPromise(closeTestDefaultSession);
    session = await Effect.runPromise(
      openTestDefaultSession({ roots: testWorkspaceRoots() }),
    );
    publishTestRunStart(session, OUTER_RUN_ID);
    await Effect.runPromise(session.log.settled);
    childId = undefined;
    // Every resume a send started: the run owed one.
    resumedRuns = [];
    const runs = session.runs;
    const resume = runs.resume.bind(runs);
    vi.spyOn(runs, 'resume').mockImplementation((runId, ...rest) => {
      resumedRuns.push(runId);
      return resume(runId, ...rest);
    });
    parentFiber = undefined;
    // A document task's revisions delegate on a model a key makes available.
    await Effect.runPromise(
      fakeHostSecrets.set(apiKeySecretName('openai'), 'test-fake-key'),
    );
  });

  afterEach(async () => {
    interruptActiveRuns(session);
    if (parentFiber) await Effect.runPromise(Fiber.await(parentFiber));
    if (childId) await waitForClaimRelease(childId);
    await Effect.runPromise(closeTestDefaultSession);
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
        const { runId, observedRequests } = yield* Effect.promise(() =>
          launchWaitingChild({ parentTurns, childTurns }),
        );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        // A child is offered what it declares, though its parent's step
        // offered nothing: a launcher's tools do not bound its child.
        expect(
          observedRequests.find(({ model }) => model === CHILD_MODEL)?.tools,
        ).toContain('grep');
        const firstHandle = session.runs.get(runId)?.handle;
        const initialBindings = bindingMocks.bindModel.mock.calls.length;
        yield* waitForParentTurns(1);
        const budget = yield* registryOf(session.runs).childRunBudget(1);
        expect(yield* budget.takeIfAvailable(1)).toBe(true);
        yield* budget.release(1);

        yield* Effect.promise(() => queueSecondAssertionFollowUp(runId));

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result B.'));
        yield* waitForParentTurns(2);
        expect(session.runs.get(runId)?.handle).toBe(firstHandle);
        expect(bindingMocks.bindModel).toHaveBeenCalledTimes(initialBindings);

        // The next turn asks the model with the follow-up as its last message
        // and turn 1's answer still in the history it carries.
        const childResumeRequest = observedRequests.find(
          ({ model, messages }) =>
            model === CHILD_MODEL &&
            JSON.stringify(messages.at(-1) ?? '').includes('second assertion'),
        );
        expect(JSON.stringify(childResumeRequest?.messages)).toContain(
          'Result A.',
        );

        yield* session.log.settled;
        const archivedChild = yield* readCompletedRunConversation(
          runId,
          session,
        );
        expect(archivedChild).toEqual([
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
        const parentText = JSON.stringify(archivedParent);
        expect(parentText.match(/Result A\./g)).toHaveLength(1);
        expect(parentText.match(/Result B\./g)).toHaveLength(1);
        expect(archivedParent).toEqual(
          expect.arrayContaining([
            { kind: 'assistant-text', text: 'Parent received result A.' },
            { kind: 'assistant-text', text: 'Parent received result B.' },
          ]),
        );
        expect(resumedRuns).toEqual([]);
        expect(parentTurns).toHaveLength(0);
        yield* session.runs.stop(runId, { reason: 'user' }).settlement;
        yield* Effect.promise(() => waitForClaimRelease(runId));
        yield* waitForParentTurns(2);
        const afterStop = yield* readCompletedRunConversation(
          PARENT_RUN_ID,
          session,
        );
        expect(JSON.stringify(afterStop).match(/Result B\./g)).toHaveLength(1);
        childTurns.push({ text: 'Recovered result C.' });
        parentTurns.push({ text: 'Parent received recovered result C.' });
        yield* queueRecovery(runId, 'Continue after restart.');
        const recovered = yield* Effect.forkChild(
          withProcessServices(testRuntime(), resumeRun(runId, { session })),
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
          completion: expect.anything(),
        });
        const recoveredHandle = session.runs.get(runId)?.handle;
        expect(recoveredHandle).toBeDefined();
        childTurns.push({ text: 'Recovered result D.' });
        parentTurns.push({ text: 'Parent received recovered result D.' });
        yield* submitFollowUp(
          runId,
          {
            text: 'Continue in the recovered run.',
            from: { kind: 'user' as const },
          },
          {
            session,
          },
        );
        yield* Effect.promise(() =>
          waitForPersistedResult(runId, 'Recovered result D.'),
        );
        yield* waitForParentTurns(4);
        expect(session.runs.get(runId)?.handle).toBe(recoveredHandle);
        yield* session.runs.stop(runId, { reason: 'user' }).settlement;
        yield* Effect.promise(() => waitForClaimRelease(runId));

        // An already idle saved run needs no new input or model turn to
        // acknowledge recovery, and its live driver still owns later input.
        expect(
          yield* withProcessServices(
            testRuntime(),
            resumeRun(runId, {
              session,
            }),
          ).pipe(Effect.timeout('5 seconds')),
        ).toEqual({
          started: true,
          delivered: true,
          outcome: RUN_PHASE.WAITING,
          completion: expect.anything(),
        });
        expect(session.runs.get(runId)?.handle).toBeDefined();
        yield* session.view.changes.pipe(
          Stream.filter(
            (view) => view.runs.get(runId)?.status === RUN_PHASE.WAITING,
          ),
          Stream.runHead,
          Effect.timeout('5 seconds'),
        );
        expect((yield* readChildTurnState(session, runId)).active).toBeNull();
        expect(childTurns).toHaveLength(0);
        yield* session.runs.stop(runId, { reason: 'user' }).settlement;
        yield* Effect.promise(() => waitForClaimRelease(runId));
        bindingMocks.bindModel.mockReturnValueOnce(
          Effect.fail(new Error('Recovered model binding failed.')),
        );
        parentTurns.push({ text: 'Parent received failed recovery.' });
        yield* queueRecovery(runId, 'Keep this unconsumed input.');
        const failedRecovery = yield* withProcessServices(
          testRuntime(),
          resumeRun(runId, { session }),
        );
        expect(failedRecovery).toEqual({
          started: true,
          delivered: false,
          outcome: RUN_OUTCOME.FAILED,
          completion: expect.anything(),
        });
        // A resumed child's lifetime ends with its own result, as a root's.
        if (!('started' in failedRecovery)) throw new Error('resume refused');
        expect((yield* failedRecovery.completion).outcome).toBe(
          RUN_OUTCOME.FAILED,
        );
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
        const { runId } = yield* Effect.promise(() =>
          launchWaitingChild({ parentTurns, childTurns }),
        );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        yield* waitForParentTurns(1);

        yield* Effect.promise(() => queueSecondAssertionFollowUp(runId));

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

        yield* session.log.settled;
        const archivedChild = yield* readCompletedRunConversation(
          runId,
          session,
        );
        // Turn 2 added the user instruction but no new assistant row.
        expect(archivedChild).toEqual([
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
        const parentText = JSON.stringify(archivedParent);
        expect(parentText.match(/Result A\./g)).toHaveLength(1);
        expect(resumedRuns).toEqual([]);
        expect(parentTurns).toHaveLength(0);
      }),
    60_000,
  );
});

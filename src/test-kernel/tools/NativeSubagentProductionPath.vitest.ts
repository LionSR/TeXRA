import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect';

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
import { refresh } from '@agent/index';
import { getRunRecords, registerRun } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { requireToolRun } from '@agent/runtime/RunCall';
import { offeredBy } from '@agent/runtime/loop/step';
import type { Message } from '@agent/runtime/loop/rows';
import { executeAgent } from '@agent/runtime/executeAgent';
import { resumeRun } from '@agent/runtime/resumeRun';
import { Runs } from '@agent/runtime/runRegistry';
import { type SessionHandle } from '@agent/runtime/SessionHandle';

// Local imports - shared/runtime boundaries
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { RunToolCall } from '@agent/runtime/RunCall';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { routePolicies } from '@agent/runtime/modelAccess/failureInfo';
import { launchDesktopAgent } from '@desktop/main/desktopAgentLaunch';
import { AgentDirectories, AppState } from '@platform/interfaces';
import { withProcessServices } from '@platform/processRuntime';
import { MODEL_RETRY_MAX_ATTEMPTS_SETTING } from '@shared/schemas';
import {
  aggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import { FakeStateStore } from '@test/support/FakePlatform';
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
  fakeHostAgentDirectories,
  fakeHostSecrets,
  setupPlatform,
  type FakeHost,
} from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  closeTestDefaultSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { localSessionBackend } from '@texra/controllers/session/sessionBackend';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { launchDetachedSubagent } from '@tools/delegation/subagentRun';
import { readCompletedRunConversation } from '@transcript';
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

/** The http arm of a binding: `identified` events carry no editor origin. */
type HttpOrigin = Exclude<ModelOrigin, { protocol: 'vscode-lm' }>;

/**
 * The transport stub: one `Model` per registry name, serving one scripted
 * turn per invocation. The loop calls `prepareTurn` then `streamTurn`, so
 * those two are the whole provider surface this fixture has to script.
 */
function scriptedOrigin(model: string): HttpOrigin {
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
  return ResolvedTurnSchema.parse({
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
  return TurnResultSchema.parse({
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
    case 'system':
      return message.text;
  }
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
      const latest = request.messages.at(-1);
      const text = latest ? messageText(latest) : '';
      progressOnly =
        config.ref === PARENT_MODEL &&
        text.includes('<subagent-progress') &&
        !text.includes('<subagent-result');
      observed.push({ model: config.ref, messages: request.messages });
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
    ...[PARENT_AGENT, CHILD_AGENT].map((name) =>
      writeFile(path.join(agentsDir, `${name}.yaml`), agentYaml(name)),
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

function agentYaml(name: string): string {
  return [
    `name: ${name}`,
    `description: Integration fixture ${name}.`,
    `prompt: You are ${name}.`,
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
  for (const runId of session.runs.activeIds()) {
    session.runs.interrupt(runId);
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

/**
 * Wait for the child's claim release. The loop's lane stays held past that
 * point while its final delivery wakes the parent, so the claim, not the
 * lane, is the durable boundary these assertions read against.
 */
/** Queue a user's input on a stopped run, which the next resume reads. */
function queueRecovery(runId: RunId, text: string) {
  return Effect.asVoid(
    session.followUps.send(runId, { text, from: { kind: 'user' } }),
  );
}

function waitForClaimRelease(runId: RunId): Promise<void> {
  return vi.waitFor(async () => {
    expect(await Effect.runPromise(session.log.owns(runId))).toBe(false);
  });
}

/** Launch one detached child of the parent run the way the `agent` tool
 *  does for a direct call: a fresh child id, the parent step's offered
 *  tools as the child's ceiling, and inherited approvals. */
const launchChild = (
  parent: RunToolCall,
  payload: Parameters<typeof launchDetachedSubagent>[1],
) =>
  Effect.gen(function* () {
    return yield* launchDetachedSubagent(parent, payload, {
      runId: generateRunId(),
      parentOffered: yield* offeredBy(parent.run),
      grants: NO_APPROVAL_GRANTS,
    });
  });

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
 * executions `send` path, asserting the queue accepted it.
 */
async function queueSecondAssertionFollowUp(
  parentContext: ParentDelegationContext,
  runId: RunId,
  instruction = 'Now prove the second assertion.',
) {
  const resumed = await testRuntime().runPromise(
    ExecutionsTool.call({
      path: `/executions/${runId}`,
      action: 'send',
      message: instruction,
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
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

  const parentConfig = AgentConfigSchema.parse({
    agent: PARENT_AGENT,
    agentSource: 'custom',
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
  const fixtureRequests = {
    nextId: (prefix: string) => prefix,
    open: () => Effect.die(new Error('This fixture opens no request.')),
  };
  const parentCall = {
    callId: 'parent-call',
    env: { roots: session.roots, workingDirectory: process.cwd() },
    emit: () => undefined,
    responseId: 'parent-response',
    instruction: undefined,
    attempt: 1,
    logId: 'parent-card',
    requests: fixtureRequests,
    run: {
      runId: PARENT_RUN_ID,
      session,
      task: null,
      opening: null,
      callbacks: {},
      fileService: new RunFileService(PARENT_RUN_ID, session.roots),
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
      steps: noStep(),
    },
  };
  const launch = await testRuntime().runPromise(
    launchChild(parentCall, {
      agent: CHILD_AGENT,
      agentSource: 'custom',
      model: CHILD_MODEL,
      instruction: 'Prove the first assertion.',
      memories: [],
      workingDirectory: process.cwd(),
    }).pipe(Effect.provideService(Runs, session.runs)),
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
        refresh(),
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
    await Effect.runPromise(closeTestDefaultSession);
    session = await Effect.runPromise(
      openTestDefaultSession({ roots: testWorkspaceRoots() }),
    );
    publishTestRunStart(session, OUTER_RUN_ID);
    await Effect.runPromise(session.log.settled);
    childId = undefined;
    // Every wake: a send that owed the run a resume.
    resumedRuns = [];
    const followUps = session.followUps;
    const send = followUps.send.bind(followUps);
    vi.spyOn(followUps, 'send').mockImplementation((runId, ...rest) =>
      send(runId, ...rest).pipe(
        Effect.tap((submitted) =>
          Effect.sync(() => {
            if (submitted.kind === 'queued' && submitted.wake)
              resumedRuns.push(runId);
          }),
        ),
      ),
    );
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
        const { runId, parentContext, observedRequests } =
          yield* Effect.promise(() =>
            launchWaitingChild({ parentTurns, childTurns }),
          );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        const firstHandle = session.runs.getHandle(runId);
        const initialBindings = bindingMocks.bindModel.mock.calls.length;
        yield* waitForParentTurns(1);
        const budget = yield* session.runs.childRunBudget(1);
        expect(yield* budget.takeIfAvailable(1)).toBe(true);
        yield* budget.release(1);

        const resumed = yield* Effect.promise(() =>
          queueSecondAssertionFollowUp(parentContext, runId),
        );
        expect(resumed.summary).toContain('Sent message');

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result B.'));
        yield* waitForParentTurns(2);
        expect(session.runs.getHandle(runId)).toBe(firstHandle);
        expect(bindingMocks.bindModel).toHaveBeenCalledTimes(initialBindings);

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
        });
        const recoveredHandle = session.runs.getHandle(runId);
        expect(recoveredHandle).toBeDefined();
        expect(session.runs.isLive(runId)).toBe(true);
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
        expect(session.runs.getHandle(runId)).toBe(recoveredHandle);
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
        });
        expect(session.runs.getHandle(runId)).toBeDefined();
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
        expect(
          yield* withProcessServices(
            testRuntime(),
            resumeRun(runId, { session }),
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
        expect(resumed.summary).toContain('Sent message');

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

  it.live(
    'delivers concurrent distinct follow-ups in admission order, each exactly once',
    () =>
      Effect.gen(function* () {
        // Delivery is immediate on admission, so two concurrent sends reach
        // the child in one batch turn or in two, whichever the turn boundary
        // finds pending. What is guaranteed is the order the rows were
        // admitted in and exactly-once delivery: a third scripted turn covers
        // the two-batch case.
        const parentTurns = [
          { text: 'Parent ready.' },
          { text: 'Parent received result A.' },
          { text: 'Parent received result B.' },
          { text: 'Parent received result C.' },
        ];
        const childTurns = [
          { text: 'Result A.' },
          { text: 'Result B.' },
          { text: 'Result C.' },
        ];
        const { runId, parentContext } = yield* Effect.promise(() =>
          launchWaitingChild({ parentTurns, childTurns }),
        );

        yield* Effect.promise(() => waitForPersistedResult(runId, 'Result A.'));
        yield* waitForParentTurns(1);

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

        // Both follow-ups consumed and answered, however they were batched.
        const followUpTexts = (rows: readonly SessionEvent[]) =>
          rows.flatMap((row) =>
            row.type === 'followup.queued' ? [row.content.text] : [],
          );
        const childNodes = yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              await Effect.runPromise(session.log.settled);
              const archived = await Effect.runPromise(
                readCompletedRunConversation(runId, session),
              );
              const nodes = archived;
              const text = JSON.stringify(nodes);
              expect(text).toContain('second assertion');
              expect(text).toContain('third assertion');
              expect(nodes.at(-1)?.kind).toBe('assistant-text');
              expect(session.view.run(runId)?.status).toBe(RUN_PHASE.WAITING);
              return nodes;
            },
            { timeout: 20_000 },
          ),
        );
        const results = childNodes.flatMap((node) =>
          node.kind === 'assistant-text' ? [node.text] : [],
        );
        const batches = results.length - 1;
        expect([1, 2]).toContain(batches);
        yield* waitForParentTurns(results.length);

        // Admission order is the rows' commit order, and the child reads the
        // sends in exactly that order, each once.
        const admitted = followUpTexts(
          yield* session.log.rows(aggregateId('run', runId)),
        )
          .map((text) => text.match(/(second|third) assertion/)?.[1])
          .filter((word) => word !== undefined);
        expect([...admitted].sort()).toEqual(['second', 'third']);
        const childText = JSON.stringify(childNodes);
        const read = [...childText.matchAll(/(second|third) assertion/g)].map(
          (match) => match[1],
        );
        expect(read).toEqual(admitted);

        // Every child result reached the child's transcript and the parent
        // exactly once, and no scripted turn is left over or missing.
        const archivedParent = yield* readCompletedRunConversation(
          PARENT_RUN_ID,
          session,
        );
        const parentText = JSON.stringify(archivedParent);
        for (const result of results) {
          expect(childText.split(result)).toHaveLength(2);
          expect(parentText.split(result)).toHaveLength(2);
        }
        expect(results).toEqual(
          ['Result A.', 'Result B.', 'Result C.'].slice(0, batches + 1),
        );
        expect(resumedRuns).toEqual([]);
        expect(childTurns).toHaveLength(2 - batches);
        expect(parentTurns).toHaveLength(2 - batches);
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
              from: { kind: 'run' as const, runId: 'c41dc41dc41d' as RunId },
              deliveryId,
            },
            { session },
          );
        }
        yield* session.log.settled;
        const afterReplay = JSON.stringify(
          yield* readCompletedRunConversation(PARENT_RUN_ID, session),
        );
        expect(afterReplay.match(/Result A\./g)).toHaveLength(1);
        expect(resumedRuns).toEqual([]);

        // A distinct delivery identity with identical text is a distinct turn.
        yield* submitFollowUp(
          PARENT_RUN_ID,
          {
            text: report!,
            from: { kind: 'run' as const, runId: 'c41dc41dc41d' as RunId },
            deliveryId: `${deliveryId}:other`,
          },
          { session },
        );
        yield* waitForParentTurns(2);
        yield* session.log.settled;
        const afterDistinct = JSON.stringify(
          yield* readCompletedRunConversation(PARENT_RUN_ID, session),
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
        const stopped = session.runs.stop(runId, { reason: 'user' });
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
  /**
   * A parent conversation that launches a workflow child from its own tool
   * call. How it can fail:
   * - the child's run takes the parent's follow-up input from the tool
   *   call's context and ends it when the child settles, so the parked
   *   parent's wait comes back empty and the parent halts cancelled;
   * - the child's result then never reaches the parent as its next turn.
   */
  it.live(
    'keeps the parent waiting for a workflow child it launched and delivers the result',
    () =>
      Effect.gen(function* () {
        const observedRequests: ObservedRequest[] = [];
        const parentTurns: ScriptedTurn[] = [
          { text: 'Launching.', call: 'launch_workflow_child' },
          { text: 'Parent launched the workflow child.' },
          { text: 'Parent received the workflow result.' },
        ];
        const childTurns: ScriptedTurn[] = [
          {
            text: '<documents>\n<document name="notes.md">\nPolished notes.\n</document>\n</documents>',
          },
        ];
        bindingMocks.bindModel.mockImplementation(
          (input: { readonly config: BoundModel['config'] }) =>
            Effect.succeed(
              scriptedBoundModel(
                input.config,
                input.config.ref === CHILD_MODEL ? childTurns : parentTurns,
                observedRequests,
              ),
            ),
        );
        const workspace = session.roots.workspace!;
        yield* Effect.promise(async () => {
          await mkdir(workspace, { recursive: true });
          await writeFile(path.join(workspace, 'notes.md'), 'Draft notes.\n');
        });
        // The delegation primitive the `agent` tool launches through, run on
        // the parent's own tool call.
        const launchWorkflowChild: ITool = {
          definition: {
            name: 'launch_workflow_child',
            description: 'Launch the workflow child.',
            parameters: {},
          },
          call: () =>
            Effect.gen(function* () {
              const parent = yield* requireToolRun('launch_workflow_child');
              const launched = yield* launchChild(
                parent,
                documentTaskConfig({
                  agent: WORKFLOW_CHILD_AGENT,
                  agentSource: 'custom',
                  model: CHILD_MODEL,
                  instruction: 'Polish the notes.',
                  inputFiles: ['notes.md'],
                  memories: [],
                }),
              );
              childId = childRunId(launched.output);
              return launched;
            }) as unknown as ReturnType<ITool['call']>,
        };
        const parentConfig = AgentConfigSchema.parse({
          agent: PARENT_AGENT,
          agentSource: 'custom',
          model: PARENT_MODEL,
          instruction: 'Polish the notes through the workflow child.',
          workingDirectory: workspace,
        });
        yield* registerRun(session, PARENT_RUN_ID, parentConfig, {
          identity: { kind: 'agent', agent: PARENT_AGENT },
          parentRunId: OUTER_RUN_ID,
        });
        parentFiber = yield* Effect.forkChild(
          withProcessServices(
            testRuntime(),
            session.runs.launchRun(
              PARENT_RUN_ID,
              prepareAgentDefinition({ config: parentConfig, session }).pipe(
                Effect.flatMap((definition) =>
                  executeAgent(definition, PARENT_RUN_ID, {
                    session,
                    parentRunId: OUTER_RUN_ID,
                    tools: [launchWorkflowChild],
                  }),
                ),
              ),
            ),
          ),
        );

        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              await Effect.runPromise(session.log.settled);
              const transcript = await Effect.runPromise(
                readCompletedRunConversation(PARENT_RUN_ID, session),
              );
              expect(transcript).toContainEqual({
                kind: 'assistant-text',
                text: 'Parent received the workflow result.',
              });
              expect(session.view.run(PARENT_RUN_ID)?.status).toBe(
                RUN_PHASE.WAITING,
              );
            },
            { timeout: 20_000 },
          ),
        );
        const delivery = observedRequests.findLast(
          ({ model }) => model === PARENT_MODEL,
        );
        expect(
          delivery?.messages.at(-1) && messageText(delivery.messages.at(-1)!),
        ).toContain('<subagent-result');
        expect(session.runs.isLive(PARENT_RUN_ID)).toBe(true);
        expect(parentTurns).toHaveLength(0);
      }),
    30_000,
  );

  /**
   * Core commits a root workflow's outcome; the host presents it afterwards.
   * How it can fail:
   * - the host's open-final-output presentation runs inside the run, so its
   *   failure ends a completed run FAILED;
   * - the presentation is dropped rather than moved, so a completed run
   *   never reaches its auto-open gate;
   * - the presentation failure is swallowed instead of reaching the caller.
   */
  it.live(
    'records a completed workflow as completed when its host presentation fails',
    () =>
      Effect.gen(function* () {
        const runId = 'b9531b9531b9' as RunId;
        bindingMocks.bindModel.mockImplementation(
          (input: { readonly config: BoundModel['config'] }) =>
            Effect.succeed(
              scriptedBoundModel(
                input.config,
                [
                  {
                    text: '<documents>\n<document name="notes.md">\nPolished notes.\n</document>\n</documents>',
                  },
                ],
                [],
              ),
            ),
        );
        const workspace = session.roots.workspace!;
        yield* Effect.promise(async () => {
          await mkdir(workspace, { recursive: true });
          await writeFile(path.join(workspace, 'notes.md'), 'Draft notes.\n');
        });
        // The host's presentation fails where it can: reading the auto-open
        // gate from a settings store that throws.
        const presentationFailure = new Error('The settings store is gone.');
        const config = session.roots.config;
        const get = config.get.bind(config);
        const gateReads: string[] = [];
        vi.spyOn(config, 'get').mockImplementation(((key: string) => {
          if (key !== 'texra.agentOutputs.autoOpenFinal') return get(key);
          gateReads.push(key);
          throw presentationFailure;
        }) as typeof config.get);

        const launch = yield* Effect.exit(
          launchDesktopAgent(
            {
              runId,
              config: AgentConfigSchema.parse(
                documentTaskConfig({
                  agent: WORKFLOW_CHILD_AGENT,
                  agentSource: 'custom',
                  model: CHILD_MODEL,
                  instruction: 'Polish the notes.',
                  inputFiles: ['notes.md'],
                }),
              ),
            },
            {
              session,
              backend: localSessionBackend(session),
              runtime: testRuntime(),
            },
          ),
        );

        expect(
          (yield* getRunRecords(session, runId).readRunEnd())?.outcome,
        ).toBe(RUN_OUTCOME.COMPLETED);
        expect(gateReads).toHaveLength(1);
        expect(launch).toStrictEqual(Exit.die(presentationFailure));
      }),
    30_000,
  );
});

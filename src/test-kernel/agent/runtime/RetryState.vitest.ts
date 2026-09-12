/**
 * The invoker's two owners of retry, over the ledger.
 *
 * Owner A is automatic and route-scoped: `classifyModelFailure` decides
 * whether an attempt repeats at all and what the session's recovery gate is
 * told about the wire route. Owner B is a human and durable: an
 * `approval.requested` row, a `pendingRetry` gate that walks
 * `waiting` -> `authorized` -> `started`, and a decision that is a retry, a
 * denial (failed, never cancelled — #7331) or a cancellation.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';
import { it } from '@effect/vitest';
import { MODEL_CONFIGS } from 'llm-zoo';
import { APIError as OpenAIAPIError } from 'openai';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { appendRow, snapshotRow } from '@agent/runtime/loop/rows';
import {
  ModelInvoker,
  modelInvokerLayer,
  type InvokeRequest,
} from '@agent/runtime/ModelInvoker';
import { AgentRun, type AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { classifyModelFailure } from '@agent/runtime/run/modelFailure';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { noopTrace, TraceEmitter, type AgentTrace } from '@agent/trace';
import { attachContextWindowError } from '@common/errors/sdkError/errorMetadata';
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
import {
  AgentCategory,
  AgentRunStateSnapshotSchema,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import {
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { getDefaultToolRegistry } from '@tools/registry';
import { isObject } from '@utils/core';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

// Local file imports
import {
  autoDecideRequests,
  seedActiveRun,
  sessionWithInteractions,
} from '../progressTestUtils';
import { testModelInfo } from './launchContextTestUtils';

/** Mirrors RETRY_BACKOFF_MS in ModelInvoker.ts. */
const RETRY_BACKOFF_MS = 1000;

const ORIGIN = {
  protocol: 'openai-chat',
  codecVersion: 1,
  requestedModel: 'gpt-test',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'openai',
  },
} satisfies ModelOrigin;

const PREPARED: ResolvedTurn = ResolvedTurnSchema.parse({
  ...ORIGIN,
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

const PROVIDER_RESPONSE_ID = 'resp-1';

/** A completed turn with one assistant message and no tool calls. */
function completedTurn(text: string): TurnResult {
  return TurnResultSchema.parse({
    kind: 'http',
    providerResponseId: PROVIDER_RESPONSE_ID,
    requestedOrigin: ORIGIN,
    returnedModel: null,
    modelFingerprint: null,
    content: [{ kind: 'message', content: [{ kind: 'text', text }] }],
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

/** What one stubbed attempt does. */
type AttemptOutcome =
  | { readonly ok: TurnResult }
  | { readonly fail: unknown }
  /** The stream ends without a `completed` event. */
  | { readonly silent: true };

interface StubModel {
  readonly model: Model;
  /** Attempts the stub has served, in order. */
  readonly attempts: () => number;
}

/**
 * A `Model` that serves one outcome per attempt, repeating the last one. The
 * invoker is the only caller, so this is the whole provider surface it drives.
 */
function stubModel(outcomes: readonly AttemptOutcome[]): StubModel {
  let served = 0;
  const next = (): AttemptOutcome => {
    const outcome = outcomes[Math.min(served, outcomes.length - 1)];
    served += 1;
    if (outcome === undefined) throw new Error('No outcome to serve');
    return outcome;
  };
  const model: Model = {
    prepareTurn: () => Effect.succeed(PREPARED),
    streamTurn: () =>
      Stream.unwrap(
        Effect.sync(() => {
          const outcome = next();
          if ('fail' in outcome) {
            return Stream.fail(
              new ModelError({
                kind: 'transport',
                message: 'attempt failed',
                cause: outcome.fail,
              }),
            );
          }
          if ('silent' in outcome) return Stream.empty;
          const events: TurnEvent[] = [
            {
              kind: 'identified',
              providerResponseId: PROVIDER_RESPONSE_ID,
              requestedOrigin: ORIGIN,
              returnedModel: null,
            },
            { kind: 'completed', result: outcome.ok },
          ];
          return Stream.fromIterable(events);
        }),
      ),
    generateTurn: () =>
      Effect.die(new Error('The run loops stream; they never generate.')),
  };
  return { model, attempts: () => served };
}

function boundModel(
  model: Model,
  overrides: Partial<BoundModel> = {},
): BoundModel {
  return {
    modelId: 'gpt54',
    config: MODEL_CONFIGS.gpt54,
    compatibilityKey: 'OpenAI',
    model,
    origin: ORIGIN,
    usageProvider: 'openai',
    usageRoute: 'api-key',
    contextWindow: MODEL_CONFIGS.gpt54.contextWindow,
    supportsVision: false,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsReasoning: false,
    supportsForcedToolChoice: true,
    wireRouteKey: JSON.stringify(['openai', 'api-key', ORIGIN.requestedModel]),
    modelRetryRouteKey: JSON.stringify([
      'openai',
      'api-key',
      ORIGIN.requestedModel,
      'gpt54',
    ]),
    routedOnKimiCode: false,
    backgroundCapable: false,
    ...overrides,
  };
}

const REQUEST: InvokeRequest = {
  system: undefined,
  tools: [],
  toolChoice: 'auto',
  round: 0,
  debugName: 'retry',
};

let retryRunCounter = 0;

/** Run ids are hex, so each scenario takes the next id in sequence. */
function retryRunId(): RunId {
  return `ac${(retryRunCounter++).toString(16).padStart(4, '0')}` as RunId;
}

const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  model: 'gpt54',
  agentCategory: AgentCategory.ToolUse,
});
const SETTING = AgentSettingSchema.parse({
  agentCategory: AgentCategory.ToolUse,
});

/** The run service the invoker reads: identity, session, trace, binding. */
function agentRun(
  runId: RunId,
  session: SessionHandle,
  logger: AgentTrace,
  model: SynchronizedRef.SynchronizedRef<BoundModel>,
): AgentRunShape {
  return {
    runId,
    parentRunId: null,
    session,
    config: CONFIG,
    setting: SETTING,
    prompt: AgentPromptSchema.parse({}),
    logger,
    parentStage: logger.openStage('Run: assistant'),
    // The launch stores a real run carries; no fixture reads through them.
    stores: hostStores(),
    toolPolicy: {},
    userVarChannels: {},
    initialUserMessageForTranscript: undefined,
    fileService: new TaskRunFileService(runId),
    tools: getDefaultToolRegistry(),
    finalToolName: null,
    structured: { value: undefined },
    model,
    scope: Scope.makeUnsafe(),
    pendingModelSwitch: { value: null },
    inScope: (operation) => operation(),
    usageMonitor: new UsageMonitor(
      { logger, runId, runStageId: undefined },
      { agentName: CONFIG.agent, agentCategory: SETTING.agentCategory },
    ),
    callbacks: { onModelChanged: () => undefined },
    interrupt: () => undefined,
  };
}

/** The opening state of a fresh tool-use run, as the loop authors it. */
const freshState = (): RunState => ({
  commit: 0,
  snapshotCommit: null,
  rowsBeforeSnapshot: 0,
  family: 'toolUse',
  step: null,
  outcome: null,
  phase: null,
  round: 0,
  turn: 0,
  continuationIndex: 0,
  modelId: 'gpt54',
  modelCompatibilityKey: 'OpenAI',
  lastError: null,
  pendingRetry: null,
  messages: [],
  continuation: null,
  openAttempt: null,
  lastTurn: null,
  pendingResponse: null,
  pendingIntents: {},
  approvals: {},
  usage: AgentRunStateSnapshotSchema.parse({}).usageAccumulator.totals,
  flow: null,
});

interface InvokerKit {
  readonly runId: RunId;
  /** The folded state of the freshly opened run. */
  readonly state: RunState;
  /** `ModelInvoker` over this run's ledger, with nothing left to provide. */
  readonly layer: Layer.Layer<ModelInvoker>;
}

/**
 * Open a run aggregate the way the tool-use loop does, and build the invoker
 * that writes to it.
 */
const openRun = Effect.fn('openRun')(function* (
  session: SessionHandle,
  model: Model,
  overrides: Partial<BoundModel> = {},
  logger: AgentTrace = noopTrace,
): Effect.fn.Return<
  InvokerKit,
  RunLedgerRefused | DatabaseReadFailed | DatabaseWriteFailed
> {
  const runId = retryRunId();
  publishTestRunStart(session, runId);
  yield* Effect.promise(() => session.settlePublications());
  yield* session.ledger.acquire(runId);
  const state = yield* session.ledger.appendBatch(runId, null, [
    appendRow(runId, [
      { role: 'user', content: [{ kind: 'text', text: 'go' }] },
    ]),
    snapshotRow(runId, freshState(), {
      phase: 'initial',
      state: { shouldSkipCycle: false, stateSlices: null },
    }),
  ]);
  const bound = yield* SynchronizedRef.make(boundModel(model, overrides));
  const layer = modelInvokerLayer.pipe(
    Layer.provide([
      Layer.succeed(AgentRun, agentRun(runId, session, logger, bound)),
      Layer.succeed(RunLedger, session.ledger),
    ]),
  );
  return { runId, state, layer };
});

/** One invocation on an opened run. */
const invokeOn = ({ layer, state }: InvokerKit) =>
  Effect.gen(function* () {
    const invoker = yield* ModelInvoker;
    return yield* invoker.invoke(state, REQUEST);
  }).pipe(Effect.provide(layer));

/** An Error carrying the HTTP status/body shape the classifiers read. */
function httpError(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), { status, ...extra });
}

/** A status-less OpenAI server_error response, as the SDK raises it. */
function statuslessServerError(message: string): OpenAIAPIError {
  const body = { type: 'server_error', code: 'server_error', message };
  return new OpenAIAPIError(undefined, body, message, undefined);
}

/**
 * The two recovery projections `gatedAttempt` hands the session gate: the
 * wire route cools on shared-route evidence, the model route only on a limit
 * the provider scoped to one model.
 */
const wireRouteRecovery = (
  error: Error,
): { retryAfterMs: number | undefined } | undefined => {
  const { verdict } = classifyModelFailure(error);
  return verdict.wireRouteFailure
    ? { retryAfterMs: verdict.retryAfterMs }
    : undefined;
};
const modelRouteRecovery = (
  error: Error,
): { retryAfterMs: number | undefined } | undefined => {
  const { verdict } = classifyModelFailure(error);
  return verdict.rateLimitScope === 'model'
    ? { retryAfterMs: verdict.retryAfterMs }
    : undefined;
};

/** Collects the modelRetryLifecycle domain events a TraceEmitter sees. */
function collectRetryLifecycleEvents(
  logger: TraceEmitter,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  logger.subscribe((event) => {
    if (
      event.type === 'domain' &&
      event.key === 'modelRetryLifecycle' &&
      isObject(event.data)
    ) {
      events.push(event.data);
    }
  });
  return events;
}

describe('model failure classification', () => {
  it('treats a user abort as a cancellation, never an automatic retry', () => {
    const abort = new DOMException('Request aborted', 'AbortError');

    expect(classifyModelFailure(abort).autoRetryable).toBe(false);
  });

  it('carries the text streamed before the failure onto the retry surface', () => {
    // The one producer of `partialText`: the loop hands `classifyModelFailure`
    // the tail it had already received, and the retry panel reads it back off
    // the classified error rather than from a provider handler.
    const error = new OpenAIAPIError(
      500,
      { message: 'stream dropped' },
      'stream dropped',
      undefined,
    );

    const failure = classifyModelFailure(error, 'api-key', 'partial answer');

    expect(failure.formatted.partialText).toBe('partial answer');
    expect(failure.info.partialText).toBe('partial answer');
    // A failure with nothing streamed carries no tail at all.
    expect(
      classifyModelFailure(statuslessServerError('nothing streamed')).formatted
        .partialText,
    ).toBeUndefined();
  });

  it('reports a retryable provider failure with its formatted message', () => {
    const error = new OpenAIAPIError(
      503,
      { message: 'transient provider failure' },
      'transient provider failure',
      undefined,
    );

    expect(classifyModelFailure(error).formatted).toMatchObject({
      message: 'HTTP 503 Service Unavailable – 503 transient provider failure',
      userRetryable: true,
    });
  });

  it.each([
    {
      name: 'a status-less OpenAI server_error response',
      error: statuslessServerError('temporary provider failure'),
      autoRetryable: true,
    },
    {
      name: 'an HTTP conflict after provider SDK retries are disabled',
      error: httpError('request lock is still held', 409),
      autoRetryable: true,
    },
    {
      name: 'a transient stream failure',
      error: new Error('stream closed after response started'),
      autoRetryable: true,
    },
    {
      name: 'a raw undici fetch failure',
      error: new TypeError('fetch failed', {
        cause: Object.assign(
          new Error('HTTP/2: "stream timeout after 300000"'),
          { code: 'UND_ERR_INFO', name: 'InformationalError' },
        ),
      }),
      autoRetryable: true,
    },
    {
      name: 'a wrapped provider fetch failure',
      error: new Error('Connection error', {
        cause: new TypeError('fetch failed'),
      }),
      autoRetryable: true,
    },
    {
      // Regression for the retry storm where a context-window overflow that
      // slipped past compaction recovery was flattened into a plain,
      // code-free Error by the transport before classification ran, so it
      // looked transient and got auto-retried with the same oversized payload
      // forever.
      name: 'a context-window overflow',
      error: (() => {
        const overflow = new Error(
          'OpenAI WebSocket response failed: overflow',
        );
        attachContextWindowError(overflow);
        return overflow;
      })(),
      autoRetryable: false,
    },
  ])('classifies $name', ({ error, autoRetryable }) => {
    expect(classifyModelFailure(error).autoRetryable).toBe(autoRetryable);
  });

  // The package's own refusals are deterministic: repeating them bills again
  // for the same answer.
  it.each(['invalid-request', 'unsupported', 'authentication'] as const)(
    'never auto-retries a %s refusal from the package',
    (kind) => {
      const error = new ModelError({ kind, message: 'refused' });

      expect(classifyModelFailure(error).autoRetryable).toBe(false);
    },
  );
});

describe('recovery-route verdicts', () => {
  it('cools the wire route on an unscoped rate limit, not the model route', () => {
    const rateLimit = httpError('rate limited', 429, {
      headers: { 'retry-after': '3' },
    });

    expect(wireRouteRecovery(rateLimit)).toEqual({ retryAfterMs: 3_000 });
    expect(modelRouteRecovery(rateLimit)).toBeUndefined();
  });

  it('cools only the model route on an explicitly model-scoped limit', () => {
    const rateLimit = httpError('model rate limited', 429, {
      headers: { 'retry-after': '3' },
      error: { type: 'rate_limit_error', scope: 'model' },
    });

    expect(wireRouteRecovery(rateLimit)).toBeUndefined();
    expect(modelRouteRecovery(rateLimit)).toEqual({ retryAfterMs: 3_000 });
  });

  it('cools the wire route on credential exhaustion across models', () => {
    const exhausted = httpError('quota exhausted', 429, {
      headers: { 'retry-after': '3' },
      error: {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });

    expect(wireRouteRecovery(exhausted)).toEqual({ retryAfterMs: 3_000 });
    expect(modelRouteRecovery(exhausted)).toBeUndefined();
  });

  it.each([
    {
      name: 'recognizes the nested Undici stream timeout from long model calls',
      error: new Error('Connection error', {
        cause: new TypeError('fetch failed', {
          cause: Object.assign(
            new Error('HTTP/2: "stream timeout after 300000"'),
            { code: 'UND_ERR_INFO' },
          ),
        }),
      }),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'recognizes a retryable HTTP status carried by an SDK error cause',
      error: new Error('request failed', {
        cause: httpError('service unavailable', 503, {
          headers: { 'retry-after': '7' },
        }),
      }),
      expected: { retryAfterMs: 7_000 },
    },
    {
      name: 'coordinates a structured status-less server failure from the SDK',
      error: statuslessServerError('temporary provider failure'),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'coordinates a status-less server failure from a background response',
      error: Object.assign(new Error('background response failed'), {
        provider: 'openai',
        error: {
          code: 'server_error',
          message: 'temporary background failure',
        },
      }),
      expected: { retryAfterMs: undefined },
    },
    {
      name: 'does not classify deterministic Undici request errors as route failures',
      error: new TypeError('fetch failed', {
        cause: Object.assign(new Error('invalid request option'), {
          code: 'UND_ERR_INVALID_ARG',
        }),
      }),
      expected: undefined,
    },
    {
      name: 'keeps per-response retries local to their invocation',
      error: new Error('stream ended before the final response event'),
      expected: undefined,
    },
    {
      name: 'honors retry-after guidance for shared HTTP failures',
      error: httpError('busy', 503, { headers: { 'retry-after': '12' } }),
      expected: { retryAfterMs: 12_000 },
    },
    {
      name: 'does not gate unrelated calls after a 401 on the api-key route',
      error: httpError('credential rejected', 401),
      expected: undefined,
    },
    {
      name: 'does not share model-specific permission failures across calls',
      error: httpError('model access denied', 403),
      expected: undefined,
    },
    {
      name: 'retries HTTP conflicts locally without cooling the shared route',
      error: httpError('conflict', 409),
      expected: undefined,
    },
  ])('$name', ({ error, expected }) => {
    expect(wireRouteRecovery(error)).toEqual(expected);
  });
});

describe('ModelInvoker retry', () => {
  afterEach(async () => {
    await installPlatform();
  });

  // The backoff is a real delay, so these three scenarios run on the live
  // clock: the gate's own waiting is Promise-tier and a test clock cannot
  // move it.
  it.live('repeats an automatic attempt and returns the response', () =>
    Effect.gen(function* () {
      const session = sessionWithInteractions(undefined);
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('recovered') },
      ]);

      const outcome = yield* invokeOn(yield* openRun(session, stub.model));

      expect(outcome.kind).toBe('response');
      expect(stub.attempts()).toBe(2);
      session.dispose();
    }),
  );

  it.effect('reports a stream that produced no completed turn as failed', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = sessionWithInteractions(undefined);
      const denied = autoDecideRequests(session, () => ({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      }));
      const stub = stubModel([{ silent: true }]);

      const outcome = yield* invokeOn(yield* openRun(session, stub.model));

      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.error.message).toContain('Model response was empty');
      }
      denied.detach();
      session.dispose();
    }),
  );

  it.effect('treats a user abort as a cancellation without prompting', () =>
    Effect.gen(function* () {
      const session = sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'retry',
      }));
      const stub = stubModel([
        { fail: new DOMException('Request aborted', 'AbortError') },
      ]);

      const outcome = yield* invokeOn(yield* openRun(session, stub.model));

      expect(outcome.kind).toBe('cancelled');
      expect(requests.opened).toEqual([]);
      requests.detach();
      session.dispose();
    }),
  );

  it.live('abandons the pending retry when the run is interrupted', () =>
    Effect.gen(function* () {
      const session = sessionWithInteractions(undefined);
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('too late') },
      ]);

      const kit = yield* openRun(session, stub.model);
      const fiber = yield* Effect.forkChild(invokeOn(kit));
      // The backoff is live, so an interrupt during it must abandon the retry
      // instead of waking up to another billed attempt.
      yield* Effect.sleep(RETRY_BACKOFF_MS / 2);
      yield* Fiber.interrupt(fiber);

      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(stub.attempts()).toBe(1);
      session.dispose();
    }),
  );

  it.effect('admits a manual retry through a durable approval', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'retry',
      }));
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('recovered') },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('response');
      expect(stub.attempts()).toBe(2);
      // The request the run opened carries the retry payload every surface
      // answers from.
      expect(requests.opened).toHaveLength(1);
      expect(requests.opened[0]?.payload).toMatchObject({
        kind: 'retry',
        data: expect.objectContaining({
          runId,
          operation: 'Model request',
          model: 'gpt54',
          kimiCodeRoutedOnFailure: false,
        }),
      });
      // The permit is retired by the response it admitted: a resumed run
      // cannot spend it a second time.
      if (outcome.kind === 'response') {
        expect(outcome.state.pendingRetry).toBeNull();
      }
      // The decision neither parks nor ends the run: the phase the fold
      // reports is still running.
      expect(session.runView(runId)?.status).toBe(RUN_PHASE.RUNNING);
      requests.detach();
      session.dispose();
    }),
  );

  // A denial does not retry and — crucially — is NOT a user cancel, so the
  // run resumes to RUNNING to let the failure terminalize (#7331); a
  // cancelled zero-output run would report COMPLETED.
  it.effect('classifies a policy retry denial as failed, not cancelled', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      }));
      const stub = stubModel([
        { fail: new Error('stream dropped before first token') },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.error.message).toContain(
          'stream dropped before first token',
        );
        expect(outcome.state.pendingRetry).toBeNull();
      }
      // A denial is not a cancel: the run stays running so the failure can
      // terminalize (#7331).
      expect(session.runView(runId)?.status).toBe(RUN_PHASE.RUNNING);
      expect(stub.attempts()).toBe(1);
      requests.detach();
      session.dispose();
    }),
  );

  it.effect('cancels the run when the user declines the retry', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const session = sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'cancel',
        cause: 'The user declined the retry.',
      }));
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
      ]);

      const kit = yield* openRun(session, stub.model);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      const outcome = yield* invokeOn(kit);

      expect(outcome.kind).toBe('cancelled');
      expect(stub.attempts()).toBe(1);
      requests.detach();
      session.dispose();
    }),
  );

  it.effect('records one operation of attempt and decision diagnostics', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({ config: { 'texra.model.retry.maxAttempts': 0 } }),
      );
      const logger = new TraceEmitter();
      const events = collectRetryLifecycleEvents(logger);
      const session = sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'retry',
      }));
      const stub = stubModel([
        { fail: httpError('temporary provider failure', 503) },
        { ok: completedTurn('recovered') },
      ]);

      const kit = yield* openRun(session, stub.model, {}, logger);
      const { runId } = kit;
      yield* Effect.promise(() => seedActiveRun(session, runId));
      yield* invokeOn(kit);

      expect(events.map((event) => [event.event, event.attempt])).toEqual([
        ['attempt_started', 1],
        ['attempt_failed', 1],
        ['retry_decision_requested', undefined],
        ['retry_decided', undefined],
        ['attempt_started', 2],
        ['attempt_succeeded', 2],
      ]);
      expect(
        events.find((event) => event.event === 'retry_decided'),
      ).toMatchObject({ action: 'retry' });
      expect(new Set(events.map((event) => event.operationId)).size).toBe(1);
      expect(
        events.every(
          (event) => event.runId === runId && event.model === 'gpt54',
        ),
      ).toBe(true);
      requests.detach();
      session.dispose();
    }),
  );

  // The setting bounds the automatic batch; the human gate opens only once it
  // is spent.
  it.live('stops automatic attempts at the configured limit', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({
          config: {
            'texra.model.retry.maxAttempts':
              MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
          },
        }),
      );
      const session = sessionWithInteractions(undefined);
      const requests = autoDecideRequests(session, () => ({
        action: 'deny',
        reason: 'Denied by TeXRA approval policy.',
      }));
      const stub = stubModel([{ fail: httpError('busy', 503) }]);

      const kit = yield* openRun(session, stub.model);
      yield* Effect.promise(() => seedActiveRun(session, kit.runId));
      yield* invokeOn(kit);

      expect(stub.attempts()).toBe(
        1 + MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
      );
      expect(requests.opened).toHaveLength(1);
      requests.detach();
      session.dispose();
    }),
  );
});

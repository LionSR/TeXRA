/**
 * The live tier's capability matrix: one set of cases every HTTP route runs,
 * live against the provider and replayed from what a live run recorded.
 *
 * A live case reaches its provider through a local relay (`cassette.ts`),
 * which forwards each request and keeps the answer. Under `LLM_RECORD=1` a
 * passing case's exchanges are scrubbed, replayed once through the same case
 * to prove the scrubbed copy still carries the contract, and written under
 * `cassettes/<route>/<case>.json`. `WireContract.vitest.ts` replays every
 * recorded cassette in the pure tier, so what a provider once sent keeps
 * being checked without a key or the network.
 *
 * The cases are deliberately thin: one per advertised capability or failure
 * mode, one request shape shared by every route, and no per-route assertion
 * beyond what that route's contract promises.
 *
 * The shared requests carry no optional controls. Each codec refuses a
 * different subset of them (Google refuses temperature and parallel calls,
 * the Chat codecs refuse storage and reasoning controls, and so on), so the
 * one request every codec admits is system text, messages and tools. Each
 * route binds the configuration a run builds for its model
 * (`configurationFor`), so its defaults are the production ones.
 */

// Node imports
import assert from 'node:assert/strict';
import process from 'node:process';

// Third-party imports
import { it } from '@effect/vitest';
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Result,
  type Scope,
  Stream,
} from 'effect';
import { describe, expect } from 'vitest';

// Local imports - the package under test
import { anthropicMessagesModel } from '../src/api/anthropicMessages.js';
import { configurationFor } from '../src/api/configuration.js';
import { googleInteractionsModel } from '../src/api/googleInteractions.js';
import { openaiResponsesModel } from '../src/api/openaiResponses.js';
import {
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
} from '../src/models/modelRoute.js';
import { chooseReasoning } from '../src/models/reasoningChoice.js';
import { selectModel } from '../src/models/modelSelection.js';
import {
  assistantMessageFromResult,
  backgroundCapable,
  completedTurn,
} from '../src/turn.js';
import type { Continuation } from '../src/message.js';
import type {
  Model,
  ModelConfiguration,
  TurnRequest,
  TurnResult,
} from '../src/turn.js';

// Local imports - the live tier
import {
  type Cassette,
  cassettePath,
  type ReceivedRequest,
  readCassette,
  relay,
  replay,
  scrubbed,
  wireServer,
  writeCassette,
} from './cassette.js';
import { type LiveRoute, ROUTES, type RouteName } from './routes.js';

const TOOL_NAME = 'lookup_capital';

const TEXT_REQUEST: TurnRequest = {
  system: 'Answer in one short sentence.',
  messages: [
    {
      role: 'user',
      content: [{ kind: 'text', text: 'What is the capital of France?' }],
    },
  ],
};

const TOOL_REQUEST: TurnRequest = {
  system: 'Call lookup_capital before answering about any capital city.',
  messages: [
    {
      role: 'user',
      content: [
        {
          kind: 'text',
          text: 'Use the lookup_capital tool for France, then answer.',
        },
      ],
    },
  ],
  tools: [
    {
      name: TOOL_NAME,
      description: 'Return the capital city of one country.',
      parameters: {
        type: 'object',
        properties: {
          country: { type: 'string', description: 'The country to look up.' },
        },
        required: ['country'],
      },
    },
  ],
};

/** Long enough that the work is still running when the cancel lands. */
const LONG_REQUEST: TurnRequest = {
  system: 'Write at length.',
  messages: [
    {
      role: 'user',
      content: [
        {
          kind: 'text',
          text: 'Write a detailed twenty-paragraph history of the city of Paris.',
        },
      ],
    },
  ],
};

/** A one-page synthetic PDF reading "The code word is LANTERN." */
const DOCUMENT_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzNjAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NSA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDM2IDk2IFRkIChUaGUgY29kZSB3b3JkIGlzIExBTlRFUk4uKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0NiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo=';

const DOCUMENT_REQUEST: TurnRequest = {
  system: 'Answer in one short sentence.',
  messages: [
    {
      role: 'user',
      content: [
        {
          kind: 'document',
          mimeType: 'application/pdf',
          base64: DOCUMENT_BASE64,
        },
        { kind: 'text', text: 'What is the code word in the document?' },
      ],
    },
  ],
};

/** The key a rejected-credential case presents: well-formed, never issued. */
const REJECTED_KEY = 'synthetic-rejected-key';

/**
 * A continuation of another protocol's origin, for the routes that refuse
 * continuation outright. It is shaped so `TurnRequestSchema` accepts it: the
 * refusal under test is the codec's contract, not input validation.
 */
const FOREIGN_CONTINUATION: Continuation = {
  coveredMessages: 1,
  prefixFingerprint: 'a'.repeat(64),
  origin: {
    protocol: 'google-interactions',
    codecVersion: 1,
    requestedModel: 'foreign-model',
    deployment: {
      endpoint: 'https://generativelanguage.googleapis.com',
      credentialScope: 'foreign-account',
    },
  },
  anchor: { interactionId: 'foreign-interaction', coveredSteps: 1 },
};

/** One turn, folded to its completed result. */
const completeTurn = Effect.fn('completeTurn')(function* (
  model: Model,
  request: TurnRequest,
) {
  const turn = yield* model.prepareTurn(request);
  assert(turn.mode === 'foreground');
  return yield* completedTurn(model.streamTurn(turn));
});

function assistantText(result: TurnResult): string {
  return result.content
    .filter((part) => part.kind === 'message')
    .flatMap((part) => part.content)
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

function localCalls(result: TurnResult) {
  return result.content.filter((part) => part.kind === 'local-call');
}

/** The calling assistant, and one success result per call it made. */
function answered(result: TurnResult): TurnRequest {
  return {
    ...TOOL_REQUEST,
    messages: [
      ...TOOL_REQUEST.messages,
      assistantMessageFromResult(result),
      {
        role: 'tool',
        results: localCalls(result).map((_call, callOrdinal) => ({
          callOrdinal,
          status: 'success' as const,
          content: [{ kind: 'text' as const, text: 'Paris' }],
        })),
      },
    ],
  };
}

/** The next turn of the same thread, accelerated by the anchor it returned. */
function followUp(result: TurnResult, continuation: Continuation): TurnRequest {
  return {
    ...TEXT_REQUEST,
    messages: [
      ...TEXT_REQUEST.messages,
      assistantMessageFromResult(result),
      {
        role: 'user',
        content: [{ kind: 'text' as const, text: 'And the capital of Italy?' }],
      },
    ],
    continuation,
  };
}

// ---------------------------------------------------------------------------
// Binding

interface BindOptions {
  /** Deliver turns as background work, where the route can. */
  readonly background?: boolean;
}

/** `route`'s configuration as a run builds it, with a short output. */
function configure(
  route: LiveRoute,
  bearer: string,
  options: BindOptions = {},
): ModelConfiguration {
  const selected = selectModel(route.model);
  assert(selected !== undefined, `The catalog has no ${route.model}.`);
  const decided = decideModelRoute(selected.config, {
    ...OWN_KEY_ROUTE_FACTS,
    ...route.route,
  });
  assert(decided.kind === 'api-key', `${route.model} takes no API key.`);
  return Result.getOrThrow(
    configurationFor({
      model: selected.config,
      route: { ...decided, endpoint: route.endpoint },
      bearer,
      options: {
        maxOutputTokens: 2048,
        temperature: 0,
        // Chosen on the route, as a run's binding chooses it.
        reasoning: Result.getOrThrow(
          chooseReasoning(selected.config, selected.request, {
            route: decided,
          }),
        ),
        serverState: true,
        background: options.background ?? false,
      },
    }),
  ).configuration;
}

/**
 * A `fetch` that sends every request to `server` instead of the host it
 * names, path and query kept, so the configuration stays the production
 * one: the deployment endpoint is still the provider's.
 */
const towards =
  (server: string): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const { pathname, search } = new URL(request.url);
    const body =
      request.body === null ? undefined : await request.arrayBuffer();
    return fetch(new URL(`${pathname}${search}`, server), {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    });
  };

/** `configuration`'s model, its HTTP requests sent to `server`. */
const bindAt = (
  configuration: ModelConfiguration,
  key: string,
  server: string,
): Effect.Effect<Model, never, Scope.Scope> => {
  const fetch = towards(server);
  switch (configuration.protocol) {
    case 'anthropic-messages':
      return Effect.orDie(
        anthropicMessagesModel(configuration, { apiKey: key, fetch }),
      );
    case 'google-interactions':
      return Effect.orDie(
        googleInteractionsModel(configuration, { apiKey: key, fetch }),
      );
    case 'openai-responses':
      return Effect.orDie(
        openaiResponsesModel(configuration, { bearer: key, fetch }),
      );
  }
};

// ---------------------------------------------------------------------------
// Cases

/** What a case runs against: bindings on one route, and what they sent. */
interface CaseContext {
  /** A new binding on the route, under the key the run holds. */
  readonly bind: (
    options?: BindOptions,
  ) => Effect.Effect<Model, never, Scope.Scope>;
  /** A new binding presenting {@link REJECTED_KEY}. */
  readonly bindRejected: Effect.Effect<Model, never, Scope.Scope>;
  /** Every request the route was sent so far. */
  readonly received: Effect.Effect<ReadonlyArray<ReceivedRequest>>;
}

interface WireCase {
  /** The cassette's file name. */
  readonly id: string;
  readonly describe: string;
  readonly it: string;
  /** Whether the route offers what the case exercises. */
  readonly applies?: (route: LiveRoute) => boolean;
  /** Runs without the route's key: the case presents none of its own. */
  readonly keyless?: boolean;
  readonly run: (
    context: CaseContext,
  ) => Effect.Effect<void, unknown, Scope.Scope>;
}

const backgroundRoute = (route: LiveRoute) =>
  backgroundCapable(configure(route, REJECTED_KEY, { background: true }));

const uploadRoute = (route: LiveRoute) => {
  const configuration = configure(route, REJECTED_KEY);
  return (
    configuration.protocol === 'anthropic-messages' ||
    (configuration.protocol === 'openai-responses' &&
      configuration.supportsDocumentInput)
  );
};

/** A background submission accepted, not already finished. */
const accepted = Effect.fn('accepted')(function* (
  model: Model,
  request: TurnRequest,
) {
  assert(model.background !== undefined);
  const turn = yield* model.prepareTurn({ ...request, mode: 'background' });
  assert(turn.mode === 'background');
  const submission = yield* model.background.submit(turn);
  return { background: model.background, turn, submission };
});

const CASES: ReadonlyArray<WireCase> = [
  {
    id: 'text-turn',
    describe: 'a text turn',
    it: 'streams assistant text into a completed result',
    run: Effect.fnUntraced(function* ({ bind }) {
      const result = yield* completeTurn(yield* bind(), TEXT_REQUEST);
      expect(result.finishReason).toBe('stop');
      expect(assistantText(result).length).toBeGreaterThan(0);
    }),
  },
  {
    id: 'tool-round-trip',
    describe: 'a tool call round trip',
    it: 'calls the tool, then answers from the result it is given',
    run: Effect.fnUntraced(function* ({ bind }) {
      const model = yield* bind();
      const called = yield* completeTurn(model, TOOL_REQUEST);
      expect(called.finishReason).toBe('tool-calls');
      expect(localCalls(called).map((call) => call.name)).toContain(TOOL_NAME);
      const answer = yield* completeTurn(model, answered(called));
      expect(answer.finishReason).toBe('stop');
      expect(assistantText(answer).length).toBeGreaterThan(0);
    }),
  },
  {
    id: 'abort',
    describe: 'an abort mid-stream',
    it: 'interrupts the reader while the response is still open',
    run: Effect.fnUntraced(function* ({ bind }) {
      const model = yield* bind();
      const turn = yield* model.prepareTurn(TEXT_REQUEST);
      assert(turn.mode === 'foreground');
      const producing = yield* Deferred.make<void>();
      // The reader parks on the first delta rather than racing the rest of
      // the response: the interrupt then always lands mid-stream, with the
      // body still open, which is the thing under test. The evidence is
      // that interruption finishes at all - a codec whose stream release
      // never returned would hang here until the timeout.
      const fiber = yield* model.streamTurn(turn).pipe(
        Stream.runForEach((event) =>
          event.kind === 'delta'
            ? Deferred.succeed(producing, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : Effect.void,
        ),
        Effect.forkChild,
      );
      // Raced against the reader's own exit: a stream that fails or ends
      // before any delta surfaces that error here instead of parking the
      // test on a deferred nobody will ever complete.
      yield* Effect.raceFirst(Deferred.await(producing), Fiber.join(fiber));
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);
    }),
  },
  {
    id: 'usage',
    describe: 'the usage shape',
    it: 'reports the counts this route bills on',
    run: Effect.fnUntraced(function* ({ bind }) {
      const { usage } = yield* completeTurn(yield* bind(), TEXT_REQUEST);
      // Every principal count in `UsageSchema` is nullable, and the
      // receipts these routes document differ: Google may report only a
      // total, and Zhipu reports no total. So the contract under test is
      // that a real receipt parsed into a usage record carrying some real
      // count of what the route bills.
      assert(usage !== null);
      const billed =
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.totalTokens ?? 0);
      expect(billed).toBeGreaterThan(0);
    }),
  },
  {
    id: 'continuation',
    describe: 'a continuation',
    it: 'chains the next turn on the anchor the first left',
    applies: (route) => route.continuation === 'supported',
    run: Effect.fnUntraced(function* ({ bind }) {
      const model = yield* bind();
      const first = yield* completeTurn(model, TEXT_REQUEST);
      const continuation = first.continuation;
      assert(continuation !== undefined);
      const second = yield* completeTurn(model, followUp(first, continuation));
      expect(second.finishReason).toBe('stop');
      expect(assistantText(second).length).toBeGreaterThan(0);
    }),
  },
  {
    id: 'continuation-refused',
    describe: 'a continuation',
    it: 'refuses an authored continuation',
    applies: (route) => route.continuation === 'unsupported',
    run: Effect.fnUntraced(function* ({ bind }) {
      const error = yield* Effect.flip(
        (yield* bind()).prepareTurn({
          ...TEXT_REQUEST,
          continuation: FOREIGN_CONTINUATION,
        }),
      );
      expect(error.kind).toBe('invalid-request');
    }),
  },
  {
    id: 'rejected-credential',
    describe: 'a rejected credential',
    it: 'fails the turn as an authentication failure',
    keyless: true,
    run: Effect.fnUntraced(function* ({ bindRejected }) {
      const error = yield* Effect.flip(
        completeTurn(yield* bindRejected, TEXT_REQUEST),
      );
      expect(error.kind).toBe('authentication');
    }),
  },
  {
    id: 'background',
    describe: 'a background turn',
    it: 'is accepted, then observed to its completed result',
    applies: backgroundRoute,
    run: Effect.fnUntraced(function* ({ bind }) {
      const { background, turn, submission } = yield* accepted(
        yield* bind({ background: true }),
        TEXT_REQUEST,
      );
      const result =
        submission.kind === 'completed'
          ? submission.result
          : yield* completedTurn(
              background.observe(turn, submission.operation, {
                deadlineAtMs: (yield* Clock.currentTimeMillis) + 150_000,
              }),
            );
      expect(result.finishReason).toBe('stop');
      expect(assistantText(result).length).toBeGreaterThan(0);
    }),
  },
  {
    id: 'cancel',
    describe: 'a background cancel',
    it: 'is confirmed by the provider before the work finishes',
    applies: backgroundRoute,
    run: Effect.fnUntraced(function* ({ bind }) {
      const { background, submission } = yield* accepted(
        yield* bind({ background: true }),
        LONG_REQUEST,
      );
      assert(submission.kind === 'accepted');
      yield* background.cancel(submission.operation);
    }),
  },
  {
    id: 'upload-release',
    describe: 'an uploaded document',
    it: 'is sent by its file id, then deleted when the binding closes',
    applies: uploadRoute,
    run: Effect.fnUntraced(function* ({ bind, received }) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const model = yield* bind();
          assert(model.uploadFile !== undefined);
          yield* model.uploadFile({
            mimeType: 'application/pdf',
            filename: 'synthetic.pdf',
            base64: DOCUMENT_BASE64,
          });
          const result = yield* completeTurn(model, DOCUMENT_REQUEST);
          expect(result.finishReason).toBe('stop');
        }),
      );
      const methods = (yield* received).map(({ method }) => method);
      expect(methods.filter((method) => method === 'DELETE')).toHaveLength(1);
    }),
  },
];

// ---------------------------------------------------------------------------
// Running a case

const RECORDING = process.env.LLM_RECORD === '1';

/** The provider's origin: where a relay forwards the route's requests. */
const originOf = (route: LiveRoute) => new URL(route.endpoint).origin;

/** `wireCase` run once against `server`, under `key`. */
const runAt = (
  route: LiveRoute,
  wireCase: WireCase,
  key: string,
  server: { readonly url: string; readonly received: CaseContext['received'] },
) =>
  wireCase.run({
    bind: (options) => bindAt(configure(route, key, options), key, server.url),
    bindRejected: bindAt(
      configure(route, REJECTED_KEY),
      REJECTED_KEY,
      server.url,
    ),
    received: server.received,
  });

/**
 * `wireCase` replayed from `cassette`, which must answer every request the
 * case sends and hold none it does not.
 */
export const replayCase = Effect.fn('replayCase')(function* (
  name: RouteName,
  wireCase: WireCase,
  cassette: Cassette,
) {
  const replayed = yield* replay(cassette);
  const server = yield* wireServer(replayed.respond);
  yield* runAt(ROUTES[name], wireCase, 'synthetic-replay-key', server);
  expect(yield* replayed.unused).toEqual([]);
});

/** Every recorded case of every route. */
export function recordedCases(): ReadonlyArray<{
  readonly name: RouteName;
  readonly wireCase: WireCase;
  readonly cassette: Cassette;
}> {
  return Object.keys(ROUTES).flatMap((key) => {
    const name = key as RouteName;
    return CASES.flatMap((wireCase) => {
      const cassette = readCassette(cassettePath(name, wireCase.id));
      return cassette === undefined ? [] : [{ name, wireCase, cassette }];
    });
  });
}

/**
 * Register the matrix for one route. Without the route's key every case
 * that needs one skips and nothing is bound, so a missing key cannot
 * surface as an authentication failure; a keyless case still runs.
 */
export function liveProtocol(name: RouteName): void {
  const route: LiveRoute = ROUTES[name];
  const apiKey = process.env[route.apiKeyEnv]?.trim();
  const keyed = apiKey !== undefined && apiKey !== '';

  describe(route.protocol, () => {
    for (const wireCase of CASES) {
      if (!(wireCase.applies?.(route) ?? true)) continue;
      describe(wireCase.describe, () => {
        it.live.skipIf(!keyed && wireCase.keyless !== true)(
          wireCase.it,
          Effect.fnUntraced(function* () {
            const recorder = yield* relay(originOf(route));
            const server = yield* wireServer(recorder.respond);
            yield* Effect.scoped(
              runAt(route, wireCase, apiKey ?? REJECTED_KEY, server),
            );
            if (!RECORDING) return;
            const exchanges = yield* recorder.recorded;
            if (exchanges.length === 0) return;
            const cassette = scrubbed(exchanges);
            // The scrubbed copy is what replays from now on, so it must
            // carry the contract the live run just passed.
            yield* Effect.scoped(replayCase(name, wireCase, cassette));
            writeCassette(cassettePath(name, wireCase.id), cassette);
          }),
        );
      });
    }
  });
}

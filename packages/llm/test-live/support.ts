/**
 * The live tier's one support file: the capability matrix every HTTP protocol
 * runs, and the fixtures it runs with.
 *
 * Everything else in this package is proved against a synthetic transport, so
 * these suites are the only evidence that a real provider's bytes survive the
 * codec. They are therefore deliberately thin: one describe per advertised
 * capability, one request shape shared by all eleven routes, and no per-route
 * assertion beyond what that route's contract actually promises.
 *
 * The shared requests carry no optional controls. Each codec refuses a
 * different subset of them (Google refuses temperature and parallel calls,
 * the Chat codecs refuse storage and reasoning controls, and so on), so the
 * one request every codec admits is system text, messages and tools. A route
 * that needs more states it in its own configuration defaults.
 *
 * `vscode-lm` is the twelfth protocol and is absent by construction: it is
 * acquired through the extension host's `vscode.lm` API
 * (`packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts`), so a
 * live check of it needs an Extension Development Host, not this Vitest
 * project.
 *
 * Model ids here are the cheapest generally available model on each route at
 * the time of writing. A provider retiring one fails its own suite and
 * nothing else; update the id in that suite.
 */

// Node imports
import assert from 'node:assert/strict';
import process from 'node:process';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Stream } from 'effect';
import { describe, expect } from 'vitest';

// Local imports - the package under test
import { assistantMessageFromResult } from '../src/turn.js';
import type {
  Continuation,
  Model,
  TurnRequest,
  TurnResult,
} from '../src/turn.js';

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

/** One live turn, folded to its completed result. */
const completeTurn = (model: Model, request: TurnRequest) =>
  Effect.gen(function* () {
    const turn = yield* model.prepareTurn(request);
    assert(turn.mode === 'foreground');
    const result = yield* model.generateTurn(turn);
    assert(result.kind === 'http');
    return result;
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

interface LiveProtocol {
  /** The protocol as `TurnProtocolSchema` names it; also the suite name. */
  readonly protocol: string;
  /** The environment variable holding this route's credential. */
  readonly apiKeyEnv: string;
  /** Bind the model to this route with that credential. */
  readonly bind: (apiKey: string) => Model;
  /**
   * Whether the codec accepts an authored `continuation`. Where it does, the
   * matrix chains a second turn on the anchor the first returned; where it
   * does not, it asserts the explicit refusal the contract promises.
   */
  readonly continuation: 'supported' | 'unsupported';
}

/**
 * Register the capability matrix for one HTTP protocol. Without the route's
 * key the whole suite skips and the binding is never built, so a missing key
 * cannot surface as an authentication failure.
 */
export function liveProtocol(spec: LiveProtocol): void {
  const apiKey = process.env[spec.apiKeyEnv]?.trim();
  const bound =
    apiKey === undefined || apiKey === '' ? null : spec.bind(apiKey);
  const model = (): Model => {
    assert(bound !== null, `${spec.apiKeyEnv} is set`);
    return bound;
  };

  describe.skipIf(bound === null)(spec.protocol, () => {
    describe('a text turn', () => {
      it.live('streams assistant text into a completed result', () =>
        Effect.gen(function* () {
          const result = yield* completeTurn(model(), TEXT_REQUEST);
          expect(result.finishReason).toBe('stop');
          expect(assistantText(result).length).toBeGreaterThan(0);
        }),
      );
    });

    describe('a tool call round trip', () => {
      it.live('calls the tool, then answers from the result it is given', () =>
        Effect.gen(function* () {
          const configured = model();
          const called = yield* completeTurn(configured, TOOL_REQUEST);
          expect(called.finishReason).toBe('tool-calls');
          expect(localCalls(called).map((call) => call.name)).toContain(
            TOOL_NAME,
          );
          const answer = yield* completeTurn(configured, answered(called));
          expect(answer.finishReason).toBe('stop');
          expect(assistantText(answer).length).toBeGreaterThan(0);
        }),
      );
    });

    describe('an abort mid-stream', () => {
      it.live('interrupts the reader while the response is still open', () =>
        Effect.gen(function* () {
          const configured = model();
          const turn = yield* configured.prepareTurn(TEXT_REQUEST);
          assert(turn.mode === 'foreground');
          const producing = yield* Deferred.make<void>();
          // The reader parks on the first delta rather than racing the rest of
          // the response: the interrupt then always lands mid-stream, with the
          // body still open, which is the thing under test. The evidence is
          // that interruption finishes at all - a codec whose stream release
          // never returned would hang here until the 180s timeout.
          const fiber = yield* configured.streamTurn(turn).pipe(
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
      );
    });

    describe('the usage shape', () => {
      it.live('reports the counts this route bills on', () =>
        Effect.gen(function* () {
          const result = yield* completeTurn(model(), TEXT_REQUEST);
          const usage = result.usage;
          // Every principal count in `UsageSchema` is nullable, and the
          // receipts these routes document differ: Google may report only a
          // total, and MiniMax bills on characters and may report only those.
          // So the contract under test is that a real receipt parsed into a
          // usage record carrying some real count of what the route bills.
          assert(usage !== null);
          const billed =
            (usage.inputTokens ?? 0) +
            (usage.outputTokens ?? 0) +
            (usage.totalTokens ?? 0) +
            (usage.providerUsage?.kind === 'minimax'
              ? usage.providerUsage.totalCharacters
              : 0);
          expect(billed).toBeGreaterThan(0);
        }),
      );
    });

    describe('a continuation', () => {
      if (spec.continuation === 'supported') {
        it.live('chains the next turn on the anchor the first left', () =>
          Effect.gen(function* () {
            const configured = model();
            const first = yield* completeTurn(configured, TEXT_REQUEST);
            const continuation = first.continuation;
            assert(continuation !== undefined);
            const second = yield* completeTurn(
              configured,
              followUp(first, continuation),
            );
            expect(second.finishReason).toBe('stop');
            expect(assistantText(second).length).toBeGreaterThan(0);
          }),
        );
      } else {
        it.live('refuses an authored continuation', () =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              model().prepareTurn({
                ...TEXT_REQUEST,
                continuation: FOREIGN_CONTINUATION,
              }),
            );
            expect(error.kind).toBe('unsupported');
          }),
        );
      }
    });
  });
}

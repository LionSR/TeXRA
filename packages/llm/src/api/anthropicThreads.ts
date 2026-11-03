// Node imports
import { hash } from 'node:crypto';

// Third-party imports
import { APIError } from '@anthropic-ai/sdk';
import { Clock, Effect, Result, Schema, type Scope } from 'effect';

// Local imports - canonical model contract
import {
  assistantMessageFromResult,
  type ResolvedTurn,
  type TurnResult,
} from '../turn.js';
import type { ModelError } from '../errors.js';
import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/messages';
import type { BetaMessageThreadParam } from '@anthropic-ai/sdk/resources/beta/messages';

/*
 * Message threads (beta): the server holds a conversation between turns, so
 * a turn that extends the previous request and its response sends only its
 * new messages and the previous response's id.
 * https://platform.claude.com/docs/en/build-with-claude/message-threads
 */
const MESSAGE_THREADS_BETA = 'message-threads-2026-08-12';

/** A request body, with the thread it creates or continues. */
type ThreadedBody = MessageCreateParamsStreaming & {
  readonly thread?: BetaMessageThreadParam;
};

// The server keeps a thread 5 minutes after its last stored response; the
// margin covers the time between storing and the next request leaving.
const THREAD_LIFETIME_MS = 270_000;
// Each entry is one live conversation on this binding (a run and its
// concurrent turns), so a handful is the working set.
const MAX_THREADS = 16;

/**
 * The key of a request prefix: the messages sent and every field a continue
 * must repeat. `system` and `tools` are left out of a continue, so they are
 * part of the key too; the output limit and stop sequences may change.
 */
function threadKey(
  body: MessageCreateParamsStreaming,
  messages: MessageCreateParamsStreaming['messages'],
): string {
  const fixed = {
    ...body,
    max_tokens: null,
    stop_sequences: null,
    messages: null,
  };
  return hash('sha256', JSON.stringify([fixed, messages]), 'hex');
}

const ThreadErrorSchema = Schema.Struct({
  error: Schema.Struct({
    details: Schema.Struct({ error_code: Schema.String }),
  }),
});

/**
 * How a rejected threaded request recovers, from the API error body:
 * `replay` sends the full conversation as a new thread, `unsupported` sends
 * it without one. The API rejects these before the model runs, so nothing
 * was generated or billed.
 */
function threadRejection(error: ModelError): 'replay' | 'unsupported' | null {
  if (!(error.cause instanceof APIError)) return null;
  const decoded = Schema.decodeUnknownResult(ThreadErrorSchema)(
    error.cause.error,
  );
  if (Result.isFailure(decoded)) return null;
  switch (decoded.success.error.details.error_code) {
    case 'thread_not_found':
    case 'thread_fingerprint_mismatch':
    case 'thread_already_continued':
    case 'thread_continue_in_flight':
      return 'replay';
    case 'thread_unsupported_request':
      return 'unsupported';
    default:
      return null;
  }
}

interface StoredThread {
  readonly responseId: string;
  /** How many lowered messages the thread holds, its response included. */
  readonly length: number;
  readonly expiresAtMs: number;
}

/** What a binding sends its requests through. */
interface MessageThreads<Source> {
  /**
   * Opens the turn's request, continuing the thread its messages extend
   * where one is live, and the completion step that stores the response's
   * thread for the next turn.
   */
  readonly send: (
    turn: ResolvedTurn,
    body: MessageCreateParamsStreaming,
  ) => Effect.Effect<
    {
      readonly source: Source;
      readonly finalize?: (
        result: TurnResult,
      ) => Effect.Effect<TurnResult, ModelError>;
    },
    ModelError,
    Scope.Scope
  >;
}

/**
 * The threads one binding holds. Only Anthropic's own API takes them: a
 * compatible endpoint that ignored the thread would answer a continue
 * without the history. A response id continues once, so taking a thread
 * removes it; the response that continuation produces is stored next.
 */
export function messageThreads<Source>(options: {
  readonly endpoint: string;
  readonly open: (
    body: ThreadedBody,
    headers: Record<string, string>,
  ) => Effect.Effect<Source, ModelError, Scope.Scope>;
  /** The request body a turn lowers to. */
  readonly lower: (
    turn: ResolvedTurn,
  ) => Effect.Effect<MessageCreateParamsStreaming, ModelError>;
}): MessageThreads<Source> {
  const live = new Map<string, StoredThread>();
  let supported = URL.parse(options.endpoint)?.hostname === 'api.anthropic.com';
  const beta = { 'anthropic-beta': MESSAGE_THREADS_BETA };

  const prune = (nowMs: number) => {
    for (const [key, stored] of live)
      if (stored.expiresAtMs <= nowMs) live.delete(key);
  };
  const take = (body: MessageCreateParamsStreaming, nowMs: number) => {
    prune(nowMs);
    for (const [key, stored] of live) {
      if (
        stored.length >= body.messages.length ||
        threadKey(body, body.messages.slice(0, stored.length)) !== key
      )
        continue;
      live.delete(key);
      // Undefined fields are not serialized; an explicit null is refused.
      return {
        ...body,
        system: undefined,
        tools: undefined,
        messages: body.messages.slice(stored.length),
        thread: { type: 'continue', previous_message_id: stored.responseId },
      } satisfies ThreadedBody;
    }
    return null;
  };
  const store = (turn: ResolvedTurn, result: TurnResult) =>
    Effect.gen(function* () {
      const responseId = result.providerResponseId;
      if (
        !supported ||
        responseId === null ||
        (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')
      )
        return result;
      // The full request with the response lowered as its last message.
      const held = yield* options.lower({
        ...turn,
        messages: [...turn.messages, assistantMessageFromResult(result)],
      });
      const nowMs = yield* Clock.currentTimeMillis;
      prune(nowMs);
      const key = threadKey(held, held.messages);
      live.set(key, {
        responseId,
        length: held.messages.length,
        expiresAtMs: nowMs + THREAD_LIFETIME_MS,
      });
      // Insertion order is age order: drop the oldest past the cap.
      for (const oldest of live.keys()) {
        if (live.size <= MAX_THREADS) break;
        live.delete(oldest);
      }
      return result;
    });

  const send: MessageThreads<Source>['send'] = (turn, body) =>
    Effect.gen(function* () {
      if (!supported) return { source: yield* options.open(body, {}) };
      const create = { ...body, thread: { type: 'create' } } as const;
      const continued = take(body, yield* Clock.currentTimeMillis);
      const source = yield* options.open(continued ?? create, beta).pipe(
        Effect.catch((error) => {
          const rejection = threadRejection(error);
          if (rejection === 'unsupported') {
            supported = false;
            live.clear();
            return Effect.logWarning(
              `Anthropic refused message threads; sending whole conversations: ${error.message}`,
            ).pipe(Effect.andThen(options.open(body, {})));
          }
          if (rejection === 'replay' && continued !== null)
            return Effect.logDebug(
              `Anthropic thread not continued; resending the conversation: ${error.message}`,
            ).pipe(Effect.andThen(options.open(create, beta)));
          return Effect.fail(error);
        }),
      );
      return {
        source,
        finalize: (result: TurnResult) => store(turn, result),
      };
    });
  return { send };
}

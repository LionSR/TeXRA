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

/** A request body, with the thread it creates or continues and its beta. */
type ThreadedBody = MessageCreateParamsStreaming & {
  readonly thread?: BetaMessageThreadParam;
  readonly betas?: Array<typeof MESSAGE_THREADS_BETA>;
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
 * `replay` and `not-found` send the full conversation as a new thread,
 * `unsupported` sends it without one. The API rejects these before the
 * model runs, so nothing was generated or billed.
 */
function threadRejection(
  error: ModelError,
): 'replay' | 'not-found' | 'unsupported' | null {
  if (!(error.cause instanceof APIError)) return null;
  const decoded = Schema.decodeUnknownResult(ThreadErrorSchema)(
    error.cause.error,
  );
  if (Result.isFailure(decoded)) return null;
  switch (decoded.success.error.details.error_code) {
    case 'thread_not_found':
      return 'not-found';
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

/**
 * How a request went out, and so how its conversation's next one goes: on a
 * thread (`replayed` when it was a full create after a lost thread), or
 * whole once the API could not store the conversation.
 */
type Mode =
  | { readonly threaded: true; readonly replayed: boolean }
  | { readonly threaded: false };

/** A conversation's last response, and how its next request goes out. */
interface StoredThread {
  readonly responseId: string;
  readonly mode: Mode;
  /** How many lowered messages the conversation holds, its response included. */
  readonly length: number;
  readonly expiresAtMs: number;
}

/** An SDK event stream, plain or beta: the codec reads either. */
export type SdkSource = AsyncIterable<unknown> & {
  readonly controller: AbortController;
};

/** What a binding sends its requests through. */
interface MessageThreads {
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
      readonly source: SdkSource;
      readonly finalize: (
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
export function messageThreads(options: {
  readonly endpoint: string;
  /** Sends a threaded body (one with `thread`) on the beta endpoint. */
  readonly open: (
    body: ThreadedBody,
  ) => Effect.Effect<SdkSource, ModelError, Scope.Scope>;
  /** The request body a turn lowers to. */
  readonly lower: (
    turn: ResolvedTurn,
  ) => Effect.Effect<MessageCreateParamsStreaming, ModelError>;
}): MessageThreads {
  const live = new Map<string, StoredThread>();
  let supported = URL.parse(options.endpoint)?.hostname === 'api.anthropic.com';
  const betas: Array<typeof MESSAGE_THREADS_BETA> = [MESSAGE_THREADS_BETA];

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
      return stored;
    }
    return null;
  };
  const store = Effect.fnUntraced(function* (
    turn: ResolvedTurn,
    result: TurnResult,
    mode: Mode,
  ) {
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
      mode,
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

  const send: MessageThreads['send'] = (turn, body) =>
    Effect.gen(function* () {
      const attempt = (request: ThreadedBody, mode: Mode) =>
        Effect.map(options.open(request), (source) => ({ source, mode }));
      const whole = attempt(body, { threaded: false });
      const create = (replayed: boolean) =>
        attempt(
          { ...body, thread: { type: 'create' }, betas },
          { threaded: true, replayed },
        );
      const stored = supported
        ? take(body, yield* Clock.currentTimeMillis)
        : null;
      // A new conversation creates a thread; a stored one continues it with
      // only the new messages, or goes out whole if the API cannot hold it.
      const first = () => {
        if (!supported || stored?.mode.threaded === false) return whole;
        if (stored === null) return create(false);
        return attempt(
          {
            ...body,
            // Undefined fields are not serialized; an explicit null is refused.
            system: undefined,
            tools: undefined,
            messages: body.messages.slice(stored.length),
            thread: {
              type: 'continue',
              previous_message_id: stored.responseId,
            },
            betas,
          },
          { threaded: true, replayed: false },
        );
      };
      const { source, mode } = yield* first().pipe(
        Effect.catch((error) => {
          const rejection = threadRejection(error);
          if (rejection === 'unsupported') {
            supported = false;
            live.clear();
            return Effect.logWarning(
              `Anthropic refused message threads; sending whole conversations: ${error.message}`,
            ).pipe(Effect.andThen(whole));
          }
          if (rejection === null || stored?.mode.threaded !== true)
            return Effect.fail(error);
          // Lost again right after a replay: the API cannot store this
          // conversation, so it goes out whole from now on.
          if (rejection === 'not-found' && stored.mode.replayed)
            return Effect.logDebug(
              `Anthropic cannot hold this conversation's thread; sending it whole: ${error.message}`,
            ).pipe(Effect.andThen(whole));
          return Effect.logDebug(
            `Anthropic thread not continued; resending the conversation: ${error.message}`,
          ).pipe(Effect.andThen(create(true)));
        }),
      );
      return {
        source,
        finalize: (result: TurnResult) => store(turn, result, mode),
      };
    });
  return { send };
}

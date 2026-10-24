/**
 * The run-history rows in the loop's terms. A stored `model.message` or
 * `context.edit` carries the storage-owned turn and history shapes
 * (`storedTurn.ts`); the loop authors, and the run fold reads, the same rows
 * with the `@texra-ai/llm` values it works in. `RunHistory` converts between
 * the two, so nothing above it sees a
 * stored turn and nothing below it sees a package type.
 */
import type {
  ContextEditPayloadSchema,
  ModelMessagePayloadSchema,
  SessionEvent,
  StoredMessage,
  StoredMessageDraft,
} from '@shared/schemas';
import type {
  AssistantMessage,
  ModelOrigin,
  RemoteOperation,
  TurnResult,
} from '@texra-ai/llm';
import type { z } from 'zod';

/**
 * One entry of the history the fold holds: the stored user and tool
 * messages, whose media parts are blob addresses, and the assistant message
 * in the package's terms. The invocation resolves the addresses into the
 * package's input parts right before the provider call (`run/mediaBytes.ts`).
 */
export type HistoryMessage =
  Exclude<StoredMessage, { readonly role: 'assistant' }> | AssistantMessage;
/** The same entry as the loop drafts it: a media part may carry its bytes,
 *  which the row codec stores under their address at write. The package's
 *  own `Message` is one, so what `mediaInput` reads appends as it is. */
export type HistoryMessageDraft =
  | Exclude<StoredMessageDraft, { readonly role: 'assistant' }>
  | AssistantMessage;

type Replace<T, R> = Omit<T, keyof R> & R;
type StoredPayload<K> = Extract<
  z.output<typeof ModelMessagePayloadSchema>,
  { kind: K }
>;

type ModelMessagePayloadOf<M> =
  | StoredPayload<'identified'>
  | StoredPayload<'failed'>
  | Replace<StoredPayload<'attempt'>, { readonly origin: ModelOrigin }>
  | Replace<StoredPayload<'accepted'>, { readonly operation: RemoteOperation }>
  | StoredPayload<'cancelled'>
  | Replace<StoredPayload<'response'>, { readonly turn: TurnResult }>
  | StoredPayload<'handed-down'>
  | Replace<StoredPayload<'append'>, { readonly messages: readonly M[] }>;
export type ModelMessagePayload = ModelMessagePayloadOf<HistoryMessage>;

type ContextEditPayloadOf<M> = Replace<
  z.output<typeof ContextEditPayloadSchema>,
  { readonly messages: readonly M[] }
>;

/** The history message a row of `Row`'s kind carries: a committed row (one
 *  with its envelope) holds media by address; a draft may hold its bytes. */
type MessageOf<Row> = Row extends { readonly commit: number }
  ? HistoryMessage
  : HistoryMessageDraft;

/** A row with its model payload in the package's terms; any other row as
 *  stored. */
export type Live<Row> = Row extends { readonly type: 'model.message' }
  ? Replace<Row, { readonly payload: ModelMessagePayloadOf<MessageOf<Row>> }>
  : Row extends { readonly type: 'context.edit' }
    ? Replace<Row, { readonly payload: ContextEditPayloadOf<MessageOf<Row>> }>
    : Row;

/** A committed row as the run fold reads it. */
export type RunHistoryRow = Live<SessionEvent>;

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
} from '@shared/schemas';
import type {
  AssistantMessage,
  ModelOrigin,
  RemoteOperation,
  TurnResult,
} from '@texra-ai/llm';

/**
 * One entry of the history the fold holds: the stored user, tool and system
 * messages, whose media parts are blob addresses, and the assistant message
 * in the package's terms. The invocation resolves the addresses into the
 * package's input parts right before the provider call
 * (`agent/runtime/storedTurn.ts`).
 */
export type HistoryMessage =
  Exclude<StoredMessage, { readonly role: 'assistant' }> | AssistantMessage;

/** A string a draft stores with its row under its address (`blobAddress`):
 *  a media part's or a captured attachment's base64, which the row names by
 *  `digest`. One without `text` is already in the store and is linked to the
 *  row, so collection keeps it while the row lives. Never part of a
 *  committed row. */
export interface DraftBlob {
  readonly digest: string;
  readonly text?: string;
}
/** A draft with the blobs it stores or links. */
export type WithBlobs<Draft> = Draft & {
  readonly blobs?: readonly DraftBlob[];
};

type Replace<T, R> = Omit<T, keyof R> & R;
type StoredPayload<K> = Extract<
  typeof ModelMessagePayloadSchema.Type,
  { kind: K }
>;

/** A `model.message` row's payload in the loop's terms: each kind as stored,
 *  with the turn, origin, operation and messages as `@texra-ai/llm` values. */
export type ModelMessagePayload =
  | StoredPayload<'identified'>
  | StoredPayload<'failed'>
  | Replace<StoredPayload<'attempt'>, { readonly origin: ModelOrigin }>
  | Replace<StoredPayload<'accepted'>, { readonly operation: RemoteOperation }>
  | StoredPayload<'cancelled'>
  | Replace<StoredPayload<'response'>, { readonly turn: TurnResult }>
  | StoredPayload<'handed-down'>
  | Replace<
      StoredPayload<'append'>,
      { readonly messages: readonly HistoryMessage[] }
    >;

type ContextEditPayload = Replace<
  typeof ContextEditPayloadSchema.Type,
  { readonly messages: readonly HistoryMessage[] }
>;

/** A row with its model payload in the package's terms; any other row as
 *  stored. A draft (no `commit` yet) may carry the blobs it stores. */
export type Live<Row> = Row extends { readonly commit: number }
  ? LiveRow<Row>
  : WithBlobs<LiveRow<Row>>;
type LiveRow<Row> = Row extends { readonly type: 'model.message' }
  ? Replace<Row, { readonly payload: ModelMessagePayload }>
  : Row extends { readonly type: 'context.edit' }
    ? Replace<Row, { readonly payload: ContextEditPayload }>
    : Row;

/** A committed row as the run fold reads it. */
export type RunHistoryRow = Live<SessionEvent>;

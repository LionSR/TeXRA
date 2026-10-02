/**
 * The run-ledger rows in the loop's terms. A stored `model.message` or
 * `context.edit` carries the storage-owned turn and history shapes
 * (`storedTurn.ts`); the loop authors, and the run fold reads, the same rows
 * with the `@texra-ai/llm` values it works in. `RunLedger` converts between
 * the two (`src/agent/runtime/storedTurn.ts`), so nothing above it sees a
 * stored turn and nothing below it sees a package type.
 */
import type {
  ContextEditPayloadSchema,
  ModelMessagePayloadSchema,
  SessionEvent,
} from '@shared/schemas';
import type {
  CancellationEvidence,
  MessageSchema,
  ModelOrigin,
  RemoteOperation,
  TurnResult,
} from '@texra-ai/llm/turn';
import type { z } from 'zod';

export type HistoryMessage = z.output<typeof MessageSchema>;

type Replace<T, R> = Omit<T, keyof R> & R;
type StoredMessage<K> = Extract<
  z.output<typeof ModelMessagePayloadSchema>,
  { kind: K }
>;

export type ModelMessagePayload =
  | StoredMessage<'identified'>
  | Replace<StoredMessage<'attempt'>, { readonly origin: ModelOrigin }>
  | Replace<StoredMessage<'accepted'>, { readonly operation: RemoteOperation }>
  | Replace<
      StoredMessage<'cancelled'>,
      { readonly evidence: CancellationEvidence }
    >
  | Replace<StoredMessage<'response'>, { readonly turn: TurnResult }>
  | Replace<
      StoredMessage<'append'>,
      { readonly messages: readonly HistoryMessage[] }
    >;

type ContextEditPayload = Replace<
  z.output<typeof ContextEditPayloadSchema>,
  { readonly messages: readonly HistoryMessage[] }
>;

/** A row with its model payload in the package's terms; any other row as
 *  stored. */
export type Live<Row> = Row extends { readonly type: 'model.message' }
  ? Replace<Row, { readonly payload: ModelMessagePayload }>
  : Row extends { readonly type: 'context.edit' }
    ? Replace<Row, { readonly payload: ContextEditPayload }>
    : Row;

/** A committed row as the run fold reads it. */
export type RunLedgerRow = Live<SessionEvent>;

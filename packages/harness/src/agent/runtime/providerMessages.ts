/**
 * The conversion between the package's turn and history values and their
 * storage-owned shapes (`@shared/schemas` `storedTurn.ts`), at the run
 * run history's boundary: `RunHistory` stores what the loop authored through
 * {@link storedDraft} and folds what it reads through {@link runHistoryRows}.
 *
 * Provider evidence crosses as `{ kind, data }`: storage keeps the bytes and
 * the package's own schemas parse them back here, so a turn another build of
 * the package can no longer read is a refusal of that run, never a default.
 */
import { Effect, Predicate, Result, Schema } from 'effect';

import {
  AssistantMessageSchema,
  checkPreparedHistory,
  MessageSchema,
  ModelOriginSchema,
  RemoteOperationSchema,
  type TurnResult,
  TurnResultSchema,
} from '@texra-ai/llm';
import {
  ContextEditPayloadSchema,
  ModelMessagePayloadSchema,
  StoredMessageSchema,
  type StoredTurnSchema,
  toJsonValue,
  type SessionRow,
  type SessionRowDraft,
  type StoredInputPart,
} from '@shared/schemas';
import type {
  DraftBlob,
  HistoryMessage,
  ModelMessagePayload,
  RunHistoryRow,
  WithBlobs,
} from '@shared/session/historyTurns';
import {
  RunHistoryInconsistent,
  type RunHistoryDraft,
} from '@shared/session/runState';
import type { StoredBlobs } from '@shared/session/database';
import { blobAddress } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { InputPart } from './run/mediaInput';

type AssertNever<T extends never> = T;
type StoredTurn = typeof StoredTurnSchema.Type;
type StoredHistoryMessage = typeof StoredMessageSchema.Type;
type LlmMessage = typeof MessageSchema.Type;
/*
 * Storage owns its copy of the turn's vocabulary, so a provider change is no
 * stored format change; these keep the copy covering every value llm can
 * produce, so an llm that adds one fails to compile here instead of failing
 * to store a turn its provider already billed.
 */
type _EveryFinishReasonIsStored = AssertNever<
  Exclude<TurnResult['finishReason'], StoredTurn['finishReason']>
>;
type _EveryOutputPartIsStored = AssertNever<
  Exclude<
    TurnResult['content'][number]['kind'],
    StoredTurn['content'][number]['kind']
  >
>;
type _EveryInputPartIsStored = AssertNever<
  Exclude<
    Extract<LlmMessage, { role: 'user' }>['content'][number]['kind'],
    StoredInputPart['kind']
  >
>;
type _EveryToolStatusIsStored = AssertNever<
  Exclude<
    Extract<LlmMessage, { role: 'tool' }>['results'][number]['status'],
    Extract<StoredHistoryMessage, { role: 'tool' }>['results'][number]['status']
  >
>;

/** The keys whose value is provider evidence, wherever a turn or a history
 *  entry holds one. */
const EVIDENCE = new Set([
  'evidence',
  'finishEvidence',
  'refusalEvidence',
  'providerUsage',
  'continuation',
]);

/** `value` with each provider-evidence object rewritten by `rewrite`. */
const mapEvidence = (
  value: unknown,
  rewrite: (evidence: Record<string, unknown>, key: string) => unknown,
): unknown => {
  if (Array.isArray(value)) return value.map((v) => mapEvidence(v, rewrite));
  if (!Predicate.isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      EVIDENCE.has(key) && Predicate.isObject(v)
        ? rewrite(v, key)
        : mapEvidence(v, rewrite),
    ]),
  );
};

/** The part of a continuation's origin its stored `kind` names. */
const ContinuationOriginSchema = Schema.Struct({
  protocol: Schema.String,
});
/** Evidence as storage keeps it: a continuation under its protocol, any
 *  other under its own `kind`. */
const stored = (value: unknown) =>
  toJsonValue(
    mapEvidence(value, ({ kind, ...data }, key) =>
      key === 'continuation'
        ? {
            kind: Schema.decodeUnknownSync(ContinuationOriginSchema)(
              data.origin,
            ).protocol,
            data,
          }
        : { kind, data },
    ),
  );
/** Evidence as storage keeps it, read back: its `data` is a JSON object. */
const StoredEvidenceSchema = Schema.Struct({
  kind: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
const live = (value: unknown) =>
  mapEvidence(value, (evidence, key) => {
    if (key === 'continuation') return evidence.data;
    const { kind, data } =
      Schema.decodeUnknownSync(StoredEvidenceSchema)(evidence);
    return { kind, ...data };
  });

/**
 * A run history row as the store keeps it, or why this build cannot store
 * it: a value the gates above cannot see (an embedder's newer llm), named
 * rather than thrown.
 */
export function storedDraft(
  row: RunHistoryDraft,
): Result.Result<WithBlobs<SessionRowDraft>, RunHistoryInconsistent> {
  const unstorable = (issue: Schema.SchemaError) =>
    new RunHistoryInconsistent({
      reason: 'unreadable-turn',
      detail: `a ${row.type} row this build of the harness cannot store: ${issue.message}`,
      commit: null,
    });
  if (row.type === 'context.edit')
    return Result.map(
      Result.mapError(
        Schema.decodeUnknownResult(ContextEditPayloadSchema)(
          stored(row.payload),
        ),
        unstorable,
      ),
      (payload) => ({ ...row, payload }),
    );
  if (row.type !== 'model.message') return Result.succeed(row);
  return Result.map(
    Result.mapError(
      Schema.decodeUnknownResult(ModelMessagePayloadSchema)(
        stored(row.payload),
      ),
      unstorable,
    ),
    (payload) => ({ ...row, payload }),
  );
}

/** A history entry as the fold holds it: the stored user, tool and system
 *  messages (media by address), the assistant message in the package's. */
const HistoryMessageSchema = Schema.Union([
  AssistantMessageSchema,
  ...StoredMessageSchema.members.filter(
    (
      member,
    ): member is Exclude<
      (typeof StoredMessageSchema.members)[number],
      { fields: { role: Schema.Literal<'assistant'> } }
    > => member.fields.role.literal !== 'assistant',
  ),
]);
const liveMessages = (messages: readonly unknown[]): HistoryMessage[] =>
  messages.map((message) =>
    Schema.decodeUnknownSync(HistoryMessageSchema)(live(message)),
  );
const PreparedRunHistorySchema = Schema.Array(HistoryMessageSchema)
  .check(Schema.isMinLength(1))
  .check(Schema.makeFilter(checkPreparedHistory));
/** Why `history` breaks the package's prepared-history rules, or null. */
export function unpreparedHistory(
  history: readonly HistoryMessage[],
): string | null {
  const parsed = Schema.decodeUnknownResult(PreparedRunHistorySchema)(history);
  return Result.isSuccess(parsed) ? null : parsed.failure.message;
}

function livePayload(
  p: typeof ModelMessagePayloadSchema.Type,
): ModelMessagePayload {
  switch (p.kind) {
    case 'identified':
    case 'failed':
    case 'cancelled':
    case 'handed-down':
      return p;
    case 'attempt':
      return {
        ...p,
        origin: Schema.decodeUnknownSync(ModelOriginSchema)(p.origin),
      };
    case 'response':
      return {
        ...p,
        turn: Schema.decodeUnknownSync(TurnResultSchema)(live(p.turn)),
      };
    case 'append':
      return { ...p, messages: liveMessages(p.messages) };
    case 'accepted':
      return {
        ...p,
        operation: Schema.decodeUnknownSync(RemoteOperationSchema)(p.operation),
      };
  }
}

function liveRow(row: SessionRow): RunHistoryRow {
  if (row.type === 'context.edit')
    return {
      ...row,
      payload: { ...row.payload, messages: liveMessages(row.payload.messages) },
    };
  if (row.type !== 'model.message') return row;
  return { ...row, payload: livePayload(row.payload) };
}

/** Committed rows as the run fold reads them, or the row whose turn this
 *  build of the package cannot read. */
export function runHistoryRows(
  rows: readonly SessionRow[],
): Result.Result<readonly RunHistoryRow[], RunHistoryInconsistent> {
  let at: SessionRow | undefined;
  return Result.try({
    try: () => rows.map((row) => liveRow((at = row))),
    catch: (cause) =>
      new RunHistoryInconsistent({
        reason: 'unreadable-turn',
        detail: `${at?.type} at commit ${at?.commit}: ${toErrorMessage(cause)}`,
        commit: at?.commit ?? null,
      }),
  });
}

/* ------------------------------------------------- media at the boundary */
// The history holds a media part by its blob address, so every reader of the
// rows, a window's replay, a resume, a child's history query, sees an address
// and never the bytes. The loop addresses the bytes it appends here, the
// invocation resolves addresses here, once per request, right before the
// provider call, and the recorded-request check turns the bytes a turn sent
// back into addresses to compare them with the rows.

type ProviderMessage = typeof MessageSchema.Type;
type ImageDetail = Extract<InputPart, { kind: 'image' }>['detail'];
type AppendedPart = InputPart | StoredInputPart;
/** A message the loop appends: its media parts with their bytes (the
 *  package's), by address (the history's), or both. */
export type AppendedMessage =
  | { readonly role: 'user'; readonly content: readonly AppendedPart[] }
  | {
      readonly role: 'tool';
      readonly results: readonly {
        readonly callOrdinal: number;
        readonly status: 'success' | 'error';
        readonly content: readonly AppendedPart[];
      }[];
    }
  | Exclude<HistoryMessage, { readonly role: 'user' | 'tool' }>;

/** The input parts of a user or tool message; none for any other. */
const inputParts = <P>(
  message:
    | { readonly role: 'user'; readonly content: readonly P[] }
    | {
        readonly role: 'tool';
        readonly results: readonly { readonly content: readonly P[] }[];
      }
    | { readonly role: 'assistant' | 'system' },
): readonly P[] => {
  if (message.role === 'user') return message.content;
  if (message.role === 'tool')
    return message.results.flatMap((result) => result.content);
  return [];
};

/** `messages` with each media part's bytes replaced by their address, and
 *  the blobs the row stores (bytes in hand) or links (already by address). */
export function addressedMessages(messages: readonly AppendedMessage[]): {
  readonly messages: readonly HistoryMessage[];
  readonly blobs: readonly DraftBlob[];
} {
  const blobs = new Map<string, DraftBlob>();
  const addressed = (part: InputPart | StoredInputPart): StoredInputPart => {
    if (part.kind === 'text') return part;
    if ('digest' in part) {
      if (!blobs.has(part.digest))
        blobs.set(part.digest, { digest: part.digest });
      return part;
    }
    const { base64, ...rest } = part;
    const digest = blobAddress(base64);
    blobs.set(digest, { digest, text: base64 });
    return { ...rest, digest };
  };
  const result = messages.map((message): HistoryMessage => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.content.map(addressed) };
      case 'tool':
        return {
          role: 'tool',
          results: message.results.map((entry) => ({
            ...entry,
            content: entry.content.map(addressed),
          })),
        };
      default:
        return message;
    }
  });
  return { messages: result, blobs: [...blobs.values()] };
}

/**
 * The history's messages as the package sends them: each media part's
 * address resolved to its base64 through `read`, the session log's blob
 * read. The one place media bytes enter a request.
 */
export const providerMessages = <E>(
  messages: readonly HistoryMessage[],
  read: (digests: readonly string[]) => Effect.Effect<StoredBlobs, E>,
): Effect.Effect<readonly ProviderMessage[], E> => {
  const digests = new Set<string>();
  for (const message of messages)
    for (const part of inputParts(message))
      if (part.kind !== 'text') digests.add(part.digest);
  const resolved = (part: StoredInputPart, texts: StoredBlobs): InputPart => {
    if (part.kind === 'text') return part;
    const { digest, ...rest } = part;
    const base64 = texts(digest);
    if (rest.kind !== 'image')
      return { kind: rest.kind, mimeType: rest.mimeType, base64 };
    const { detail, ...image } = rest;
    if (detail === undefined) return { ...image, base64 };
    // cast: storage keeps the detail a string; the package validates the request.
    return { ...image, base64, detail: detail as NonNullable<ImageDetail> };
  };
  return Effect.map(read([...digests]), (texts) =>
    messages.map((message): ProviderMessage => {
      switch (message.role) {
        case 'user':
          return {
            role: 'user',
            content: message.content.map((part) => resolved(part, texts)),
          };
        case 'tool':
          return {
            role: 'tool',
            results: message.results.map((entry) => ({
              ...entry,
              content: entry.content.map((part) => resolved(part, texts)),
            })),
          };
        default:
          return message;
      }
    }),
  );
};

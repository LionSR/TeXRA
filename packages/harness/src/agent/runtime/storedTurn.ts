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
import { Effect, Predicate, Result } from 'effect';

import {
  AssistantMessageSchema,
  checkPreparedHistory,
  MessageSchema,
  ModelOriginSchema,
  RemoteOperationSchema,
  TurnResultSchema,
  type RemoteOperation,
} from '@texra-ai/llm';
import { z } from 'zod';
import {
  ContextEditPayloadSchema,
  ModelMessagePayloadSchema,
  StoredMessageSchema,
  toJsonValue,
  type SessionEvent,
  type SessionEventDraft,
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
import { blobAddress } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

/** Evidence as storage keeps it: a continuation under its protocol, any
 *  other under its own `kind`. */
const stored = (value: unknown) =>
  toJsonValue(
    mapEvidence(value, ({ kind, ...data }, key) =>
      key === 'continuation'
        ? { kind: (data.origin as { protocol: string }).protocol, data }
        : { kind, data },
    ),
  );
const live = (value: unknown) =>
  mapEvidence(value, (evidence, key) =>
    key === 'continuation'
      ? evidence.data
      : { kind: evidence.kind, ...(evidence.data as object) },
  );

const storedOperation = ({
  origin,
  providerResponseId,
  ...cursor
}: RemoteOperation) => ({
  origin,
  providerResponseId,
  // Wrapped once, by `stored`, like every other evidence value.
  evidence: { kind: origin.protocol, ...cursor },
});

/** A run history row as the store keeps it. */
export function storedDraft(
  row: RunHistoryDraft,
): WithBlobs<SessionEventDraft> {
  if (row.type === 'context.edit')
    return {
      ...row,
      payload: ContextEditPayloadSchema.parse(stored(row.payload)),
    };
  if (row.type !== 'model.message') return row;
  const { payload } = row;
  return {
    ...row,
    payload: ModelMessagePayloadSchema.parse(
      stored(
        payload.kind === 'accepted'
          ? { ...payload, operation: storedOperation(payload.operation) }
          : payload,
      ),
    ),
  };
}

/** A history entry as the fold holds it: the stored user, tool and system
 *  messages (media by address), the assistant message in the package's. */
const HistoryMessageSchema = z.discriminatedUnion('role', [
  AssistantMessageSchema,
  ...StoredMessageSchema.options.filter(
    (
      option,
    ): option is Exclude<
      (typeof StoredMessageSchema.options)[number],
      { shape: { role: z.ZodLiteral<'assistant'> } }
    > => option.shape.role.value !== 'assistant',
  ),
]);
const liveMessages = (messages: readonly unknown[]): HistoryMessage[] =>
  messages.map((message) => HistoryMessageSchema.parse(live(message)));
const PreparedRunHistorySchema = z
  .array(HistoryMessageSchema)
  .min(1)
  .superRefine(checkPreparedHistory)
  .readonly();
/** Why `history` breaks the package's prepared-history rules, or null. */
export function unpreparedHistory(
  history: readonly HistoryMessage[],
): string | null {
  const parsed = PreparedRunHistorySchema.safeParse(history);
  return parsed.success ? null : parsed.error.message;
}

function livePayload(
  p: z.output<typeof ModelMessagePayloadSchema>,
): ModelMessagePayload {
  switch (p.kind) {
    case 'identified':
    case 'failed':
    case 'cancelled':
    case 'handed-down':
      return p;
    case 'attempt':
      return { ...p, origin: ModelOriginSchema.parse(p.origin) };
    case 'response':
      return { ...p, turn: TurnResultSchema.parse(live(p.turn)) };
    case 'append':
      return { ...p, messages: liveMessages(p.messages) };
    case 'accepted': {
      const { origin, providerResponseId, evidence } = p.operation;
      return {
        ...p,
        operation: RemoteOperationSchema.parse({
          origin,
          providerResponseId,
          ...evidence.data,
        }),
      };
    }
  }
}

function liveRow(row: SessionEvent): RunHistoryRow {
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
  rows: readonly SessionEvent[],
): Result.Result<readonly RunHistoryRow[], RunHistoryInconsistent> {
  let at: SessionEvent | undefined;
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

type ProviderMessage = z.output<typeof MessageSchema>;
type ProviderInputPart = Extract<
  ProviderMessage,
  { readonly role: 'user' }
>['content'][number];
type ImageDetail = Extract<ProviderInputPart, { kind: 'image' }>['detail'];
type AppendedPart = ProviderInputPart | StoredInputPart;
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
  const addressed = (
    part: ProviderInputPart | StoredInputPart,
  ): StoredInputPart => {
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
  read: (
    digests: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, E>,
): Effect.Effect<readonly ProviderMessage[], E> => {
  const digests = new Set<string>();
  for (const message of messages)
    for (const part of inputParts(message))
      if (part.kind !== 'text') digests.add(part.digest);
  const resolved = (
    part: StoredInputPart,
    texts: ReadonlyMap<string, string>,
  ): ProviderInputPart => {
    if (part.kind === 'text') return part;
    const { digest, ...rest } = part;
    const base64 = texts.get(digest);
    // `read` fails on a digest the store lacks, so none is missing here.
    if (base64 === undefined) throw new Error(`Media blob ${digest} not read`);
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

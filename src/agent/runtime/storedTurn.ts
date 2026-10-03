/**
 * The conversion between the package's turn and history values and their
 * storage-owned shapes (`@shared/schemas` `storedTurn.ts`), at the run
 * ledger's boundary: `RunLedger` stores what the loop authored through
 * {@link storedDraft} and folds what it reads through {@link ledgerRows}.
 *
 * Provider evidence crosses as `{ kind, data }`: storage keeps the bytes and
 * the package's own schemas parse them back here, so a turn another build of
 * the package can no longer read is a refusal of that run, never a default.
 */
import { Result } from 'effect';

import {
  CancellationEvidenceSchema,
  MessageSchema,
  ModelOriginSchema,
  RemoteOperationSchema,
  TurnResultSchema,
  type RemoteOperation,
} from '@texra-ai/llm/turn';
import {
  ContextEditPayloadSchema,
  ModelMessagePayloadSchema,
  toJsonValue,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import type {
  ModelMessagePayload,
  RunLedgerRow,
} from '@shared/session/ledgerTurns';
import {
  RunLedgerInconsistent,
  type RunLedgerDraft,
} from '@shared/session/runStateFold';
import { isObject } from '@utils/core';
import type { z } from 'zod';

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
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      EVIDENCE.has(key) && isObject(v)
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

/** A ledger row as the store keeps it. */
export function storedDraft(row: RunLedgerDraft): SessionEventDraft {
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

const liveMessages = (messages: readonly unknown[]) =>
  messages.map((message) => MessageSchema.parse(live(message)));

function livePayload(
  p: z.output<typeof ModelMessagePayloadSchema>,
): ModelMessagePayload {
  switch (p.kind) {
    case 'identified':
      return p;
    case 'attempt':
      return { ...p, origin: ModelOriginSchema.parse(p.origin) };
    case 'cancelled':
      return {
        ...p,
        evidence: CancellationEvidenceSchema.parse({
          kind: p.evidence.kind,
          ...p.evidence.data,
        }),
      };
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

function liveRow(row: SessionEvent): RunLedgerRow {
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
export function ledgerRows(
  rows: readonly SessionEvent[],
): Result.Result<readonly RunLedgerRow[], RunLedgerInconsistent> {
  let at: SessionEvent | undefined;
  return Result.try({
    try: () => rows.map((row) => liveRow((at = row))),
    catch: (cause) =>
      new RunLedgerInconsistent({
        reason: 'unreadable-turn',
        detail: `${at?.type} at commit ${at?.commit}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        commit: at?.commit ?? null,
      }),
  });
}

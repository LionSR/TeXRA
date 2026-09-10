/** Canonical global inquiry content; project events carry display notifications only. */
import { Context, Effect, Layer, Result } from 'effect';

import {
  InquiryThreadIdSchema,
  ToolError,
  type OwnerId,
  type InquiryThreadId,
  type InquiryThreadSummary,
  type InquiryThreadRecord,
  type OpenInquiryTurn,
  type AnsweredInquiryTurn,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { toNewestFirstByTimestamp, unique, hexId12 } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import { WorkspaceRoots } from './WorkspaceRoots';
import { databaseLayer } from './Database';

const QUESTION_PREVIEW_CHARS = 200;

/** The global inquiry owner is configured once; database connections are operation-scoped. */
function inquiryOperations(
  globalStorage: () => string,
  ownerId: OwnerId,
): Context.Service.Shape<typeof InquiryRecords> {
  /** Each operation owns its connection; SQLite serializes transitions across processes. */
  const inGlobalDatabase = <A, E>(operation: Effect.Effect<A, E, Database>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Effect.try({
          try: globalStorage,
          catch: ensureError,
        });
        return yield* operation.pipe(
          Effect.provide(
            databaseLayer('persistent').pipe(
              Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
              Layer.provide(ProcessIdentity.layer(ownerId)),
            ),
          ),
        );
      }),
    );

  const changeThread = <A extends InquiryThreadRecord | null>(
    id: InquiryThreadId,
    change: (current: InquiryThreadRecord | null) => A,
  ) =>
    inGlobalDatabase(
      Effect.gen(function* () {
        const database = yield* Database;
        const result = yield* database.updateInquiryRecord(id, (current) =>
          Result.try({
            try: () => change(current),
            catch: ensureError,
          }),
        );
        return yield* Effect.fromResult(result);
      }),
    );

  function normalizeSessionLinks(
    links?: string[] | null,
  ): string[] | undefined {
    if (!links?.length) return undefined;

    const normalized = unique(
      links.map((link) => link.trim()).filter((link) => link.length > 0),
    );

    return normalized.length ? normalized : undefined;
  }

  // ============================================================================
  // Open / answer / drop helpers
  // ============================================================================

  /**
   * Append a new open question to a thread. Creates the thread when no
   * thread_id is passed (or the existing thread is unknown). Updates the
   * thread's `parentRunId` to the caller; continuations always flow back
   * to the most-recent asker.
   *
   * Behavior depends on the current status of the addressed thread:
   *   - new thread        → create with status='open'
   *   - 'answered'        → append a new open turn (follow-up); status flips back to 'open'
   *   - 'open'            → reject (already has an unanswered question)
   *   - 'dropped'         → reject (terminal)
   */
  function recordOpenQuestion(
    params: Parameters<
      Context.Service.Shape<typeof InquiryRecords>['recordOpenQuestion']
    >[0],
  ) {
    const threadId = params.threadId ?? (`ei_${hexId12()}` as InquiryThreadId);

    return changeThread(threadId, (existing) => {
      if (params.threadId && !existing) {
        throw new ToolError(`External inquiry thread not found: ${threadId}`);
      }

      if (existing) {
        if (existing.status === 'open') {
          throw new ToolError(
            'Thread already has an open question; wait for the continuation. ' +
              'Use inquiry { command: "read", thread_id } to inspect or list to recover thread IDs. ' +
              'Do not re-dispatch.',
          );
        }
        if (existing.status === 'dropped') {
          throw new ToolError(
            'Thread was dropped by user; start a new thread instead.',
          );
        }
      }

      const timestamp = new Date().toISOString();
      const baseManifest: InquiryThreadRecord = existing ?? {
        threadId,
        parentRunId: params.parentRunId,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
        turns: [],
      };

      const turnIndex = baseManifest.turns.length + 1;
      const trimmedContext = params.context?.trim() || undefined;

      const turn: OpenInquiryTurn = {
        turnIndex,
        timestamp,
        question: params.question,
        context: trimmedContext,
        kind: 'open',
        suggestSearch: params.suggestSearch ?? undefined,
        attachFiles: params.attachFiles?.length
          ? params.attachFiles
          : undefined,
      };

      const nextManifest: InquiryThreadRecord = {
        ...baseManifest,
        parentRunId: params.parentRunId,
        status: 'open',
        updatedAt: timestamp,
        turns: [...baseManifest.turns, turn],
      };

      return nextManifest;
    });
  }

  /**
   * Persist the user-supplied answer onto the thread's current open turn.
   * Flips status `open → answered`.
   *
   * Returns `null` if the thread has no open turn (e.g. already answered,
   * or dropped).
   */
  function recordAnswerForOpenTurn(
    params: Parameters<
      Context.Service.Shape<typeof InquiryRecords>['recordAnswerForOpenTurn']
    >[0],
  ) {
    return changeThread(params.threadId, (existing) => {
      if (
        !existing ||
        existing.status !== 'open' ||
        existing.turns.length === 0
      )
        return null;

      // Safe: the length check above guarantees at least one turn.
      const lastTurn = existing.turns.at(-1)!;
      if (lastTurn.kind !== 'open' || lastTurn.turnIndex !== params.turnIndex)
        return null;

      const timestamp = new Date().toISOString();
      const sessionLinks = normalizeSessionLinks(params.sessionLinks);

      const answeredTurn: AnsweredInquiryTurn = {
        ...lastTurn,
        kind: 'answered',
        answer: params.answer,
        answeredAt: timestamp,
        sessionLinks,
      };

      const nextManifest: InquiryThreadRecord = {
        ...existing,
        status: 'answered',
        updatedAt: timestamp,
        turns: [...existing.turns.slice(0, -1), answeredTurn],
      };

      return nextManifest;
    });
  }

  /**
   * Mark the thread as dropped by the user. Only valid from `open`;
   * stale or duplicate drop actions arriving after a submit must NOT
   * overwrite an `answered` status (which would emit a contradictory
   * dropped continuation and corrupt the audit trail).
   *
   * Returns the just-written manifest on success so callers can pass it to the
   * continuation injector without a re-read, matching `recordAnswerForOpenTurn`.
   * Returns `null` when the drop was a no-op (already answered/dropped
   * or not found).
   */
  function markDropped(
    params: Parameters<
      Context.Service.Shape<typeof InquiryRecords>['markDropped']
    >[0],
  ) {
    return changeThread(params.threadId, (existing) => {
      if (!existing) return null;
      if (existing.status !== 'open') return null;
      if (existing.turns.at(-1)?.turnIndex !== params.turnIndex) return null;

      const timestamp = new Date().toISOString();
      const nextManifest: InquiryThreadRecord = {
        ...existing,
        status: 'dropped',
        updatedAt: timestamp,
      };

      return nextManifest;
    });
  }

  // ============================================================================
  // Public read API
  // ============================================================================

  /** Read a canonical thread manifest. */
  function readExternalInquiryThread(threadId: string) {
    const parsed = InquiryThreadIdSchema.safeParse(threadId);
    if (!parsed.success) return Effect.succeed(null);
    return inGlobalDatabase(
      Effect.flatMap(Database, (database) =>
        database.readInquiryRecord(parsed.data),
      ),
    );
  }

  function manifestToSummary(
    manifest: InquiryThreadRecord,
  ): InquiryThreadSummary {
    const lastTurn = manifest.turns.at(-1);
    return {
      threadId: manifest.threadId,
      parentRunId: manifest.parentRunId,
      status: manifest.status,
      lastQuestionPreview: (lastTurn?.question ?? '').slice(
        0,
        QUESTION_PREVIEW_CHARS,
      ),
      lastActivityIso: manifest.updatedAt,
      turnCount: manifest.turns.length,
    };
  }

  function getThreadSummary(threadId: InquiryThreadId) {
    return readExternalInquiryThread(threadId).pipe(
      Effect.map((record) => (record ? manifestToSummary(record) : null)),
    );
  }

  function listThreadsByStatus(
    params: Parameters<
      Context.Service.Shape<typeof InquiryRecords>['listThreadsByStatus']
    >[0],
  ) {
    return inGlobalDatabase(
      Effect.gen(function* () {
        const database = yield* Database;
        const all = yield* database.listInquiryRecords();

        const filtered = all.filter((m) => {
          if (params.status !== 'any' && m.status !== params.status)
            return false;
          if (params.scope === 'run') {
            if (!params.runId) return false;
            if (m.parentRunId !== params.runId) return false;
          }
          return true;
        });

        const sorted = toNewestFirstByTimestamp(
          filtered,
          (manifest) => manifest.updatedAt,
        );

        const trimmed =
          params.limit != null ? sorted.slice(0, params.limit) : sorted;
        return trimmed.map(manifestToSummary);
      }),
    );
  }

  return {
    recordOpenQuestion,
    recordAnswerForOpenTurn,
    markDropped,
    readExternalInquiryThread,
    getThreadSummary,
    listThreadsByStatus,
  };
}

/** Provide the inquiry owner without opening a connection until an operation runs. */
export const inquiryRecordsLayer = (globalStorage: () => string) =>
  Layer.effect(
    InquiryRecords,
    Effect.map(ProcessIdentity, ({ ownerId }) =>
      inquiryOperations(globalStorage, ownerId),
    ),
  );

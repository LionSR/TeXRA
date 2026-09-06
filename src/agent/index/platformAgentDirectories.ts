import * as path from 'node:path';

import { Clock, Effect, Result, Schedule } from 'effect';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { GlobalStorageFS } from '@utils/files/storageFS';

import {
  AgentDirectoryService,
  type AgentDirectoryIssueReporter,
} from './AgentDirectoryService';
import { BUNDLED_AGENT_DIRECTORY_NAMES } from './BundledAgentDirectories';

const SYNC_MARKER_FILE = '.bundled-agent-sync.json';
const RECENT_EXTERNAL_SYNC_MS = 5 * 60 * 1000;

/**
 * Ownership retry policy: exponential backoff from 100ms capped at 1s (the
 * `min` of the two schedules is the shorter delay, so the exponential stops
 * growing once it passes the spaced one), jittered, and bounded by 20
 * recurrences or 30 seconds total — whichever comes first.
 */
const LOCK_RETRY_POLICY = Schedule.min([
  Schedule.exponential('100 millis', 1.5),
  Schedule.spaced('1 second'),
]).pipe(
  Schedule.jittered,
  Schedule.upTo({ duration: '30 seconds', times: 20 }),
);

type Log = ReturnType<typeof createLog>;

interface PlatformAgentDirectoryOptions {
  channel: string;
  customDirectoryStore: { get(): string | undefined };
  /** Defaults to logging the issue at `warn`; hosts with an interactive
   * notification surface (e.g. the VS Code extension) can override it. */
  issueReporter?: AgentDirectoryIssueReporter;
}

export function createPlatformAgentDirectories(
  options: PlatformAgentDirectoryOptions,
): AgentDirectoryService {
  const log = createLog(options.channel);
  return new AgentDirectoryService({
    channel: options.channel,
    customDirectoryStore: options.customDirectoryStore,
    issueReporter: options.issueReporter ?? {
      report: async (message, docsId) =>
        log.warn(`${message}. See documentation: ${docsId}`),
    },
  });
}

// ============================================================================
// Bundled agent reconciliation
// ============================================================================

function isLockContentionError(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ELOCKED';
}

const AgentDirectorySyncMarkerSchema = z.object({
  completedAt: z.number().nonnegative(),
  ownerPid: z.int().nonnegative(),
  version: z.string().nullish(),
});

interface BundledAgentReconcileOptions {
  channel: string;
  /** Packaged resources root holding the bundled agent directories. */
  resourcesPath: string;
  currentVersion: string | undefined;
  /** Global-state key under which this host records the version it synced. */
  versionStateKey: string;
}

/**
 * The sync marker, or undefined when there is none this process can trust.
 * A missing file is the ordinary case; an unreadable or malformed one is a
 * degradation, so it is reported at `warn` before being ignored.
 */
const readSyncMarker = Effect.fn('platformAgentDirectories.readSyncMarker')(
  function* (log: Log) {
    const raw = yield* Effect.tryPromise({
      try: () => GlobalStorageFS.read(SYNC_MARKER_FILE),
      catch: (cause) => cause as NodeJS.ErrnoException,
    }).pipe(
      Effect.catchIf(isFileNotFoundError, () => Effect.succeed(undefined)),
      Effect.catch((error) =>
        Effect.sync(() => {
          log.warn(
            `Ignoring bundled agent sync marker: ${toErrorMessage(error)}`,
          );
          return undefined;
        }),
      ),
    );
    if (raw === undefined) return undefined;
    const parsed = parseJsonWith(raw, AgentDirectorySyncMarkerSchema);
    if (Result.isFailure(parsed)) {
      const { failure } = parsed;
      log.warn(
        `Ignoring malformed bundled agent sync marker: ${
          failure instanceof z.ZodError
            ? z.prettifyError(failure)
            : toErrorMessage(failure)
        }`,
      );
      return undefined;
    }
    return parsed.success;
  },
);

const writeSyncMarker = Effect.fn('platformAgentDirectories.writeSyncMarker')(
  function* (currentVersion: string | undefined, log: Log) {
    const completedAt = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: async () => {
        await GlobalStorageFS.ensureDir('');
        await GlobalStorageFS.write(
          SYNC_MARKER_FILE,
          `${JSON.stringify({
            completedAt,
            ownerPid: process.pid,
            version: currentVersion,
          })}\n`,
        );
      },
      catch: (cause) => cause as Error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          log.warn(
            `Failed to write bundled agent sync marker: ${toErrorMessage(error)}`,
          ),
        ),
      ),
    );
  },
);

/**
 * True when another live process already reconciled this exact version
 * moments ago, so this process can adopt its result instead of re-copying.
 * Own-process markers never count: this process must still reconcile after
 * an upgrade even though it wrote the previous marker.
 */
const hasRecentExternalSync = Effect.fn(
  'platformAgentDirectories.hasRecentExternalSync',
)(function* (currentVersion: string | undefined, log: Log) {
  const marker = yield* readSyncMarker(log);
  if (!marker || marker.ownerPid === process.pid) return false;
  if ((marker.version ?? undefined) !== currentVersion) return false;
  const now = yield* Clock.currentTimeMillis;
  return now - marker.completedAt < RECENT_EXTERNAL_SYNC_MS;
});

const reconcileUnlocked = Effect.fn('platformAgentDirectories.reconcile')(
  function* (options: BundledAgentReconcileOptions, log: Log) {
    const globalState = platform().globalState;
    // `StateStore` mirrors `vscode.Memento`, so its writes stay Promises;
    // this is the single wrap of that port, not a Promise lane of its own.
    const recordVersion = Effect.tryPromise({
      try: async () =>
        globalState.update(options.versionStateKey, options.currentVersion),
      catch: (cause) => cause as Error,
    });
    if (yield* hasRecentExternalSync(options.currentVersion, log)) {
      yield* recordVersion;
      return;
    }

    for (const directoryName of BUNDLED_AGENT_DIRECTORY_NAMES) {
      yield* Effect.tryPromise({
        try: async () => {
          await GlobalStorageFS.ensureDir(directoryName);
          await platform().fs.copy(
            path.join(options.resourcesPath, directoryName),
            GlobalStorageFS.fullPath(directoryName),
            { overwrite: true },
          );
        },
        catch: (cause) => cause as Error,
      });
    }

    yield* recordVersion;
    yield* writeSyncMarker(options.currentVersion, log);
  },
);

/**
 * Copy the packaged agent directories into global storage, coordinating with
 * any other process that shares it through an on-disk lock plus a sync marker.
 *
 * Ownership contention retries on {@link LOCK_RETRY_POLICY} while the lock is
 * still held elsewhere and the operation has not started; a live or stale
 * owner that outlasts the policy leaves the shared cache untouched (answered
 * `false`) rather than failing startup. Every other failure — an unreadable or
 * partially written agent directory included — is reported at `error` and
 * answered `false`, so no host's activation can abort on it.
 */
export const bootstrapPlatformAgentDirectories = Effect.fn(
  'platformAgentDirectories.bootstrap',
)(function* (options: BundledAgentReconcileOptions) {
  const log = createLog(options.channel);
  // Whether the critical section ran: a failure after it started is a real
  // reconcile failure, never contention to retry or to skip quietly.
  let operationStarted = false;
  // Suspended so every retry re-resolves the port and takes the lock again,
  // rather than replaying one already-built acquisition.
  const reconciled = yield* Effect.suspend(() =>
    platform().fileLocks.withFileLock(
      GlobalStorageFS.fullPath(SYNC_MARKER_FILE),
    )(
      Effect.sync(() => {
        operationStarted = true;
      }).pipe(Effect.andThen(reconcileUnlocked(options, log))),
    ),
  ).pipe(
    Effect.retry({
      schedule: LOCK_RETRY_POLICY,
      while: (error) => !operationStarted && isLockContentionError(error),
    }),
    Effect.as(true),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (!operationStarted && isLockContentionError(error)) {
          log.warn(
            'Skipping bundled agent refresh because another process still owns the sync lock',
          );
        } else {
          log.error(`Error copying default agents: ${toErrorMessage(error)}`);
        }
        return false;
      }),
    ),
  );
  return reconciled;
});

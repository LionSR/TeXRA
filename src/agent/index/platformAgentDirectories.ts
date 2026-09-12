import * as path from 'node:path';

import { Clock, Effect, Result } from 'effect';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { createLog } from '@logger/logUtils';
import { AppState } from '@platform/interfaces';
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

const reconcile = Effect.fn('platformAgentDirectories.reconcile')(function* (
  options: BundledAgentReconcileOptions,
  log: Log,
) {
  const globalState = yield* AppState;
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
});

/**
 * Copy the packaged agent directories into global storage, recording the
 * result in the sync marker so a sibling process that reconciled the same
 * version moments ago is adopted instead of re-copying.
 *
 * Nothing excludes concurrent hosts: two processes starting together may both
 * copy the same bundled directories over each other. The copy is idempotent —
 * the source is immutable packaged content, so both writers write the same
 * bytes to the same destinations and converge on the same result — and the
 * marker only spares the redundant work when the timing allows. Any failure —
 * an unreadable or partially written agent directory included — is reported at
 * `error` and answered `false`, so no host's activation can abort on it.
 */
export const bootstrapPlatformAgentDirectories = Effect.fn(
  'platformAgentDirectories.bootstrap',
)(function* (options: BundledAgentReconcileOptions) {
  const log = createLog(options.channel);
  return yield* reconcile(options, log).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.sync(() => {
        log.error(`Error copying default agents: ${toErrorMessage(error)}`);
        return false;
      }),
    ),
  );
});

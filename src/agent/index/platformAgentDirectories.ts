import * as path from 'node:path';

import pRetry from 'p-retry';
import { z } from 'zod';

import {
  isFileNotFoundError,
  isNotADirectoryError,
} from '@common/errors/errorPredicates';
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
const LOCK_RETRY_TIMEOUT_MS = 30_000;

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
    storage: {
      ensureDir: (relativePath) => GlobalStorageFS.ensureDir(relativePath),
      fullPath: (relativePath) => GlobalStorageFS.fullPath(relativePath),
    },
    customDirectoryStore: options.customDirectoryStore,
    absoluteDirectories: {
      exists: async (target) => {
        try {
          await platform().fs.stat(target);
          return true;
        } catch (error) {
          // Match AbsoluteFS/BaseFS.statIfExists: an ancestor path component
          // that turned out to be a file (ENOTDIR) means "does not exist"
          // here too, not an error to propagate.
          if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
            return false;
          }
          throw error;
        }
      },
      ensureDir: (target) => platform().fs.createDirectory(target),
    },
    issueReporter: options.issueReporter ?? {
      report: async (message, docsId) =>
        log.warn(`${message}. See documentation: ${docsId}`),
    },
    logger: {
      debug: (message, data) => log.debug(message, { data }),
      error: (message, data) => log.error(message, { data }),
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

type AgentDirectorySyncMarker = z.output<typeof AgentDirectorySyncMarkerSchema>;

interface BundledAgentReconcileOptions {
  channel: string;
  /** Packaged resources root holding the bundled agent directories. */
  resourcesPath: string;
  currentVersion: string | undefined;
  /** Global-state key under which this host records the version it synced. */
  versionStateKey: string;
}

async function readSyncMarker(
  log: Log,
): Promise<AgentDirectorySyncMarker | undefined> {
  try {
    const raw = await GlobalStorageFS.read(SYNC_MARKER_FILE);
    const parsed = AgentDirectorySyncMarkerSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn(
        `Ignoring malformed bundled agent sync marker: ${z.prettifyError(parsed.error)}`,
      );
      return undefined;
    }
    return parsed.data;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    log.warn(`Ignoring bundled agent sync marker: ${toErrorMessage(error)}`);
    return undefined;
  }
}

async function writeSyncMarker(
  currentVersion: string | undefined,
  log: Log,
): Promise<void> {
  try {
    await GlobalStorageFS.ensureDir('');
    await GlobalStorageFS.write(
      SYNC_MARKER_FILE,
      `${JSON.stringify({
        completedAt: Date.now(),
        ownerPid: process.pid,
        version: currentVersion,
      })}\n`,
    );
  } catch (error) {
    log.warn(
      `Failed to write bundled agent sync marker: ${toErrorMessage(error)}`,
    );
  }
}

/**
 * True when another live process already reconciled this exact version
 * moments ago, so this process can adopt its result instead of re-copying.
 * Own-process markers never count: this process must still reconcile after
 * an upgrade even though it wrote the previous marker.
 */
async function hasRecentExternalSync(
  currentVersion: string | undefined,
  log: Log,
): Promise<boolean> {
  const marker = await readSyncMarker(log);
  if (!marker || marker.ownerPid === process.pid) return false;
  if ((marker.version ?? undefined) !== currentVersion) return false;
  return Date.now() - marker.completedAt < RECENT_EXTERNAL_SYNC_MS;
}

async function reconcileUnlocked(
  options: BundledAgentReconcileOptions,
  log: Log,
): Promise<void> {
  const globalState = platform().globalState;
  if (await hasRecentExternalSync(options.currentVersion, log)) {
    await globalState.update(options.versionStateKey, options.currentVersion);
    return;
  }

  for (const directoryName of BUNDLED_AGENT_DIRECTORY_NAMES) {
    await GlobalStorageFS.ensureDir(directoryName);
    await platform().fs.copy(
      path.join(options.resourcesPath, directoryName),
      GlobalStorageFS.fullPath(directoryName),
      { overwrite: true },
    );
  }

  await globalState.update(options.versionStateKey, options.currentVersion);
  await writeSyncMarker(options.currentVersion, log);
}

async function reconcileBundledAgentDirectories(
  options: BundledAgentReconcileOptions,
  log: Log,
): Promise<void> {
  let operationStarted = false;

  try {
    await pRetry(
      () =>
        platform().fileLocks.runExclusive(
          GlobalStorageFS.fullPath(SYNC_MARKER_FILE),
          () => {
            operationStarted = true;
            return reconcileUnlocked(options, log);
          },
        ),
      {
        retries: 20,
        minTimeout: 100,
        maxTimeout: 1_000,
        randomize: true,
        maxRetryTime: LOCK_RETRY_TIMEOUT_MS,
        shouldRetry: ({ error }) =>
          !operationStarted && isLockContentionError(error),
      },
    );
  } catch (error) {
    // A live or stale owner must not make startup fail. If ownership remains
    // unavailable, leave the shared cache untouched and try again next run.
    if (!operationStarted && isLockContentionError(error)) {
      log.warn(
        'Skipping bundled agent refresh because another process still owns the sync lock',
      );
      return;
    }
    throw error;
  }
}

/**
 * Copy the packaged agent directories into global storage, coordinating with
 * any other process that shares it through an on-disk lock plus a sync marker.
 */
export async function bootstrapPlatformAgentDirectories(
  options: BundledAgentReconcileOptions,
): Promise<boolean> {
  const log = createLog(options.channel);
  try {
    await reconcileBundledAgentDirectories(options, log);
    return true;
  } catch (error) {
    // An unreadable or partially written agent directory must not abort host
    // startup — VS Code activation in particular has to survive it. Loud, not
    // silent: the cause is logged at error and the host continues with
    // whatever bundled agents already reconciled.
    log.error(`Error copying default agents: ${toErrorMessage(error)}`);
    return false;
  }
}

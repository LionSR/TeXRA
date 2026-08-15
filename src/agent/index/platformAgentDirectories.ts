import {
  isFileNotFoundError,
  isNotADirectoryError,
} from '@common/errors/errorPredicates';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import {
  AgentDirectoryService,
  type AgentDirectoryIssueReporter,
} from './AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  type AgentDirectoryBundleSource,
  type AgentDirectoryVersionStore,
} from './AgentDirectorySync';

interface PlatformAgentDirectoryOptions {
  channel: string;
  customDirectoryStore: { get(): string | undefined };
  /** Defaults to logging the issue at `warn`; hosts with an interactive
   * notification surface (e.g. the VS Code extension) can override it. */
  issueReporter?: AgentDirectoryIssueReporter;
}

export interface PlatformAgentDirectoryBootstrapOptions {
  channel: string;
  bundleSource: AgentDirectoryBundleSource;
  currentVersion: string | undefined;
  versionStore: AgentDirectoryVersionStore;
}

export function createPlatformAgentDirectories(
  options: PlatformAgentDirectoryOptions,
): AgentDirectoryService {
  const log = createLog(options.channel);
  return new AgentDirectoryService({
    storage: new GlobalStorageAgentDirectoryStorage(),
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

export async function bootstrapPlatformAgentDirectories(
  options: PlatformAgentDirectoryBootstrapOptions,
): Promise<void> {
  const log = createLog(options.channel);
  const sync = new BundledAgentDirectorySync({
    bundleSource: options.bundleSource,
    storage: new GlobalStorageAgentDirectoryStorage(),
    versionStore: options.versionStore,
    logger: {
      info: (message, data) => log.info(message, { data }),
      warn: (message, data) => log.warn(message, { data }),
    },
  });

  await sync.reconcile(options.currentVersion);
}

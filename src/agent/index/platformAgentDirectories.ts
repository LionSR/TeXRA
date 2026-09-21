import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';

import {
  AgentDirectoryService,
  type AgentDirectoryIssueReporter,
} from './AgentDirectoryService';

interface PlatformAgentDirectoryOptions {
  channel: string;
  /** Packaged resources root holding this host's bundled agent directories. */
  resourcesPath: string;
  customDirectoryStore: { get(): string | undefined };
  /** Defaults to logging the issue at `warn`; hosts with an interactive
   * notification surface (e.g. the VS Code extension) can override it. */
  issueReporter?: AgentDirectoryIssueReporter;
}

export function createPlatformAgentDirectories(
  options: PlatformAgentDirectoryOptions,
): AgentDirectoryService {
  return new AgentDirectoryService({
    channel: options.channel,
    resourcesPath: options.resourcesPath,
    customDirectoryStore: options.customDirectoryStore,
    issueReporter: options.issueReporter ?? {
      report: (message, docsId) =>
        Effect.logWarning(`${message}. See documentation: ${docsId}`).pipe(
          withLogChannel(options.channel),
        ),
    },
  });
}

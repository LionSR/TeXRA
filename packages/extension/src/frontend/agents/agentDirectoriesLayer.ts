// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Layer } from 'effect';

// Local imports
import { AgentDirectories, AppState } from '@texra-ai/harness';
import { AgentDirectoryService } from '@agent/index';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';

const CHANNEL = 'AgentLoad';

/**
 * The extension's `AgentDirectories` port, served over `AppState`. Built-in
 * agents are read straight out of the installed extension's `resources`,
 * never copied into global storage.
 */
export const agentDirectoriesLayer = (extensionPath: string) =>
  Layer.effect(
    AgentDirectories,
    Effect.map(
      AppState,
      (state) =>
        new AgentDirectoryService({
          channel: CHANNEL,
          resourcesPath: path.join(extensionPath, 'resources'),
          state,
          issueReporter: {
            report: (message, docsId) =>
              showLoggedMessageWithDocs(CHANNEL, message, docsId),
          },
        }),
    ),
  );

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - controllers
// Local imports - shared
import {
  AgentCatalog,
  isStrictlyWithin,
  type ProcessServices,
} from '@texra-ai/harness';
import { agentKey, isPackagedAgentSource } from '@texra-ai/harness/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { MessageHost } from '@texra/hosts/uiHosts';
import { type SettingsMessageFor } from '@texra/shared/settingsView/settingsViewMessages';
// Local imports - utilities

/**
 * One step of a settings agent action: the host's own failure, on the process
 * services every host's runtime provides. Each handler below composes these
 * into one program that its host runs at its own message dispatch — which is
 * also where the failure is reported, so this module runs nothing itself.
 */
type SettingsActionEffect<A> = Effect.Effect<A, Error, ProcessServices>;

interface AgentFileHandlers {
  openAgentYaml(
    message: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML>,
  ): SettingsActionEffect<void>;
  customizeAgent(
    message: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT>,
  ): SettingsActionEffect<void>;
  deleteCustomAgent(
    message: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT
    >,
  ): SettingsActionEffect<void>;
  revealAgentFile(
    message: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE
    >,
  ): SettingsActionEffect<void>;
}

interface SettingsAgentActionsOptions {
  readonly getCustomAgentDirectory: () => SettingsActionEffect<string>;
  readonly openDocument: (filePath: string) => SettingsActionEffect<void>;
  /**
   * Show a file the user must not edit in place. Hosts present it however
   * they can without handing back a buffer that saves over the original.
   */
  readonly openReadOnlyDocument: (
    filePath: string,
  ) => SettingsActionEffect<void>;
  readonly revealFile: (filePath: string) => SettingsActionEffect<void>;
  readonly confirmAction: (
    message: string,
    confirmLabel: string,
  ) => SettingsActionEffect<boolean>;
  readonly showInfoMessage: MessageHost['showInfoMessage'];
  readonly showErrorMessage: MessageHost['showErrorMessage'];
  readonly refreshAfterMutation: () => SettingsActionEffect<void>;
  /** Drop a deleted custom agent's agent choices (its hidden key). */
  readonly forgetDeletedAgent: (name: string) => SettingsActionEffect<void>;
}

/**
 * Why an agent's YAML could not be opened. The lookup and both failure modes
 * are host-neutral, so the sentence lives
 * beside the sibling `Agent not found or has no file` messages below rather
 * than being a port each host answers in its own words.
 */
function openAgentYamlErrorMessage(
  reason: 'missingAgent' | 'missingPath',
  agentName: string,
): string {
  return reason === 'missingAgent'
    ? `Agent "${agentName}" could not be found. It may have been removed or renamed. Check the Agents tab in Settings to see available agents.`
    : `No configuration file found for agent "${agentName}". The agent definition may be incomplete — try re-creating it from the Agents tab.`;
}

/**
 * Build the settings handlers whose file-system decisions are identical in
 * every graphical host. Presentation and catalog refresh policy
 * remain explicit dependencies.
 */
export function createSettingsAgentActions(
  options: SettingsAgentActionsOptions,
): AgentFileHandlers {
  // A delete already in flight for this agent swallows a second click (#9487):
  // the second request would otherwise open another confirmation and then
  // report the agent the first one removed as not found.
  const activeDeletions = new Set<string>();
  return {
    openAgentYaml: (message) =>
      Effect.gen(function* () {
        const entry = (yield* AgentCatalog).get(
          agentKey(message.agentSource, message.agentName),
        );
        if (!entry?.path) {
          yield* options.showErrorMessage(
            openAgentYamlErrorMessage(
              entry ? 'missingPath' : 'missingAgent',
              message.agentName,
            ),
          );
          return;
        }
        // A packaged definition lives inside the installed host bundle, so
        // opening the file itself would let a save mutate the built-in agent
        // every later scan and launch reads — and silently bypass the
        // adjacent Customize action that makes the editable copy.
        yield* isPackagedAgentSource(message.agentSource)
          ? options.openReadOnlyDocument(entry.path)
          : options.openDocument(entry.path);
      }),

    revealAgentFile: (message) =>
      Effect.gen(function* () {
        const entry = (yield* AgentCatalog).get(
          agentKey(message.agentSource, message.agentName),
        );
        if (!entry?.path) {
          yield* options.showErrorMessage(
            `Agent not found or has no file: ${message.agentName}`,
          );
          return;
        }
        yield* options.revealFile(entry.path);
      }),

    customizeAgent: (message) =>
      Effect.gen(function* () {
        if (message.agentSource === 'plugin') {
          yield* options.showErrorMessage(
            `${message.agentName} comes from an installed plugin and has no editable copy; edit the plugin's own agent file instead.`,
          );
          return;
        }
        const entry = (yield* AgentCatalog).get(
          agentKey(message.agentSource, message.agentName),
        );
        if (!entry?.path || entry.digest == null) {
          yield* options.showErrorMessage(
            `Agent not found or has no file: ${message.agentName}`,
          );
          return;
        }

        // A copy already there is replaced only on the user's say-so.
        const catalog = yield* AgentCatalog;
        const targetPath = yield* catalog
          .customize(entry, 'copy')
          .pipe(
            Effect.catchTag('AgentCustomizeRefused', (refused) =>
              refused.reason === 'exists' && refused.path !== undefined
                ? Effect.flatMap(
                    options.confirmAction(
                      `A custom copy already exists: ${path.basename(refused.path)}`,
                      'Overwrite',
                    ),
                    (overwrite) =>
                      overwrite
                        ? catalog.customize(entry, 'overwrite')
                        : Effect.succeed(undefined),
                  )
                : Effect.as(
                    options.showErrorMessage(refused.message),
                    undefined,
                  ),
            ),
          );
        if (targetPath === undefined) return;

        yield* options.refreshAfterMutation();
        yield* options.openDocument(targetPath);
        yield* options.showInfoMessage(
          `Created custom copy: ${path.basename(targetPath)}`,
        );
      }),

    deleteCustomAgent: (message) =>
      Effect.suspend(() => {
        if (activeDeletions.has(message.agentName)) return Effect.void;
        activeDeletions.add(message.agentName);
        return Effect.gen(function* () {
          const entryPath = (yield* AgentCatalog).get(
            agentKey('custom', message.agentName),
          )?.path;
          if (!entryPath) {
            yield* options.showErrorMessage(
              `Custom agent not found: ${message.agentName}`,
            );
            return;
          }

          const customDir = yield* options.getCustomAgentDirectory();
          if (!isStrictlyWithin(customDir, entryPath)) {
            yield* options.showErrorMessage(
              'Refusing to delete: file is not inside the custom agents directory.',
            );
            return;
          }

          const confirmed = yield* options.confirmAction(
            `Delete "${message.agentName}"? This cannot be undone.`,
            'Delete',
          );
          if (!confirmed) return;

          const fs = yield* FileSystem.FileSystem;
          // `force` is the facade's delete: a path already gone is the
          // post-condition, not a failure.
          yield* fs.remove(entryPath, { force: true });
          // The removal is real only here: the agent list forgets its choice.
          yield* options.forgetDeletedAgent(message.agentName);
          yield* options.showInfoMessage(
            `Deleted custom agent: ${message.agentName}`,
          );
          yield* options.refreshAfterMutation();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => activeDeletions.delete(message.agentName)),
          ),
        );
      }),
  };
}

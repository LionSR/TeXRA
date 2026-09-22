// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - controllers
import type { MessageHost } from '@hosts/uiHosts';
import type { ProcessServices } from '@platform/processRuntime';
// Local imports - shared
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { isPackagedAgentSource, type AgentSource } from '@shared/schemas';
import { type SettingsMessageFor } from '@shared/settingsView/settingsViewMessages';
// Local imports - utilities
import { entryExists } from '@utils/files/fsEntryExists';
import { isStrictlyWithin } from '@utils/core/pathCore';

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

/** The four commands these handlers answer — the key each host reports a
 *  failure under. */
export type AgentFileCommand = keyof AgentFileHandlers;

interface SettingsAgentActionsOptions {
  readonly findAgent: (
    source: AgentSource,
    name: string,
  ) => { path?: string } | undefined;
  readonly getCustomAgentDirectory: () => SettingsActionEffect<string>;
  readonly getSourceDirectory: (
    source: AgentSource,
  ) => SettingsActionEffect<string | undefined>;
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
  return {
    openAgentYaml: (message) =>
      Effect.gen(function* () {
        const entry = options.findAgent(message.agentSource, message.agentName);
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
        const entry = options.findAgent(message.agentSource, message.agentName);
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
        const entryPath = options.findAgent(
          message.agentSource,
          message.agentName,
        )?.path;
        if (!entryPath) {
          yield* options.showErrorMessage(
            `Agent not found or has no file: ${message.agentName}`,
          );
          return;
        }

        // Both directory reads start together, as the `Promise.all` they
        // replace did.
        const [customDir, sourceDir] = yield* Effect.all(
          [
            options.getCustomAgentDirectory(),
            options.getSourceDirectory(message.agentSource),
          ],
          { concurrency: 'unbounded' },
        );
        const relativePath = sourceDir
          ? path.relative(sourceDir, entryPath)
          : path.basename(entryPath);
        const targetPath = path.join(customDir, relativePath);
        if (!isStrictlyWithin(customDir, targetPath)) {
          yield* options.showErrorMessage(
            'Refusing to copy: target path escapes the custom agents directory.',
          );
          return;
        }

        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
        const targetExists = yield* entryExists(fs, targetPath);
        if (targetExists) {
          const overwrite = yield* options.confirmAction(
            `A custom copy already exists: ${path.basename(targetPath)}`,
            'Overwrite',
          );
          if (!overwrite) return;
        }

        yield* fs.copy(entryPath, targetPath, { overwrite: true });
        yield* options.openDocument(targetPath);
        yield* options.showInfoMessage(
          `Created custom copy: ${path.basename(targetPath)}`,
        );
        yield* options.refreshAfterMutation();
      }),

    deleteCustomAgent: (message) =>
      Effect.gen(function* () {
        const entryPath = options.findAgent('custom', message.agentName)?.path;
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
        yield* options.showInfoMessage(
          `Deleted custom agent: ${message.agentName}`,
        );
        yield* options.refreshAfterMutation();
      }),
  };
}

/** What each host reports when one of the four actions fails — kept beside
 *  the handlers so both hosts report the same sentence. */
export const FAILURE_MESSAGES: Readonly<Record<AgentFileCommand, string>> = {
  openAgentYaml: 'Failed to open agent YAML file',
  customizeAgent: 'Failed to create custom agent copy',
  deleteCustomAgent: 'Failed to delete custom agent',
  revealAgentFile: 'Failed to reveal agent file',
};

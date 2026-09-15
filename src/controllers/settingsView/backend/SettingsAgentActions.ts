// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports - controllers
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import type { MessageHost } from '@hosts/uiHosts';
// Local imports - shared
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  isPackagedAgentSource,
  type AgentSource,
  type SettingsMessageFor,
} from '@shared/schemas';
// Local imports - utilities
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { ensureError } from '@utils/errors/errorMessage';

interface AgentFileHandlers {
  openAgentYaml(
    message: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML>,
  ): Promise<void>;
  customizeAgent(
    message: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT>,
  ): Promise<void>;
  deleteCustomAgent(
    message: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT
    >,
  ): Promise<void>;
  revealAgentFile(
    message: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE
    >,
  ): Promise<void>;
}

type AgentFileCommand = keyof AgentFileHandlers;

interface SettingsAgentActionsOptions {
  readonly directoryController: Pick<
    SettingsAgentDirectoryController,
    'planOpenAgentYaml' | 'planRevealAgentFile'
  >;
  readonly findAgent: (
    source: AgentSource,
    name: string,
  ) => { path?: string } | undefined;
  readonly getCustomAgentDirectory: () => Promise<string>;
  readonly getSourceDirectory: (
    source: AgentSource,
  ) => Promise<string | undefined>;
  readonly openDocument: (filePath: string) => Promise<void>;
  /**
   * Show a file the user must not edit in place. Hosts present it however
   * they can without handing back a buffer that saves over the original.
   */
  readonly openReadOnlyDocument: (filePath: string) => Promise<void>;
  readonly revealFile: (filePath: string) => Promise<void>;
  readonly confirmAction: (
    message: string,
    confirmLabel: string,
  ) => Promise<boolean>;
  readonly showInfoMessage: MessageHost['showInfoMessage'];
  readonly showErrorMessage: MessageHost['showErrorMessage'];
  readonly refreshAfterMutation: () => Promise<void>;
  /**
   * Run one command's program and report its failure through the host's own
   * surface. The program is an Effect so the notifications above stay typed
   * end to end; the Promise options it drives keep their raw rejections,
   * wrapped as `Error` at the one boundary.
   */
  readonly run: (
    failureMessage: string,
    action: Effect.Effect<void, Error>,
  ) => Promise<void>;
}

/**
 * Why an agent's YAML could not be opened. The lookup and both failure modes
 * are host-neutral — `planOpenAgentYaml` decides them — so the sentence lives
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
  const run = (
    command: AgentFileCommand,
    action: Effect.Effect<void, Error>,
  ): Promise<void> => options.run(FAILURE_MESSAGES[command], action);

  return {
    openAgentYaml: (message) =>
      run(
        message.command,
        Effect.gen(function* () {
          const result = options.directoryController.planOpenAgentYaml({
            source: message.agentSource,
            name: message.agentName,
          });
          if (!result.ok) {
            yield* options.showErrorMessage(
              openAgentYamlErrorMessage(result.reason, message.agentName),
            );
            return;
          }
          // A packaged definition lives inside the installed host bundle, so
          // opening the file itself would let a save mutate the built-in agent
          // every later scan and launch reads — and silently bypass the
          // adjacent Customize action that makes the editable copy.
          yield* Effect.tryPromise({
            try: () =>
              isPackagedAgentSource(message.agentSource)
                ? options.openReadOnlyDocument(result.path)
                : options.openDocument(result.path),
            catch: ensureError,
          });
        }),
      ),

    revealAgentFile: (message) =>
      run(
        message.command,
        Effect.gen(function* () {
          const result = options.directoryController.planRevealAgentFile({
            source: message.agentSource,
            name: message.agentName,
          });
          if (!result.ok) {
            yield* options.showErrorMessage(
              `Agent not found or has no file: ${message.agentName}`,
            );
            return;
          }
          yield* Effect.tryPromise({
            try: () => options.revealFile(result.path),
            catch: ensureError,
          });
        }),
      ),

    customizeAgent: (message) =>
      run(
        message.command,
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

          const [customDir, sourceDir] = yield* Effect.tryPromise({
            try: () =>
              Promise.all([
                options.getCustomAgentDirectory(),
                options.getSourceDirectory(message.agentSource),
              ]),
            catch: ensureError,
          });
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

          yield* Effect.tryPromise({
            try: () => AbsoluteFS.ensureDir(path.dirname(targetPath)),
            catch: ensureError,
          });
          const targetExists = yield* Effect.tryPromise({
            try: () => AbsoluteFS.exists(targetPath),
            catch: ensureError,
          });
          if (targetExists) {
            const overwrite = yield* Effect.tryPromise({
              try: () =>
                options.confirmAction(
                  `A custom copy already exists: ${path.basename(targetPath)}`,
                  'Overwrite',
                ),
              catch: ensureError,
            });
            if (!overwrite) return;
          }

          yield* Effect.tryPromise({
            try: () =>
              AbsoluteFS.copy(entryPath, targetPath, { overwrite: true }),
            catch: ensureError,
          });
          yield* Effect.tryPromise({
            try: () => options.openDocument(targetPath),
            catch: ensureError,
          });
          yield* options.showInfoMessage(
            `Created custom copy: ${path.basename(targetPath)}`,
          );
          yield* Effect.tryPromise({
            try: () => options.refreshAfterMutation(),
            catch: ensureError,
          });
        }),
      ),

    deleteCustomAgent: (message) =>
      run(
        message.command,
        Effect.gen(function* () {
          const entryPath = options.findAgent(
            'custom',
            message.agentName,
          )?.path;
          if (!entryPath) {
            yield* options.showErrorMessage(
              `Custom agent not found: ${message.agentName}`,
            );
            return;
          }

          const customDir = yield* Effect.tryPromise({
            try: () => options.getCustomAgentDirectory(),
            catch: ensureError,
          });
          if (!isStrictlyWithin(customDir, entryPath)) {
            yield* options.showErrorMessage(
              'Refusing to delete: file is not inside the custom agents directory.',
            );
            return;
          }

          const confirmed = yield* Effect.tryPromise({
            try: () =>
              options.confirmAction(
                `Delete "${message.agentName}"? This cannot be undone.`,
                'Delete',
              ),
            catch: ensureError,
          });
          if (!confirmed) return;

          yield* Effect.tryPromise({
            try: () => AbsoluteFS.delete(entryPath, { recursive: false }),
            catch: ensureError,
          });
          yield* options.showInfoMessage(
            `Deleted custom agent: ${message.agentName}`,
          );
          yield* Effect.tryPromise({
            try: () => options.refreshAfterMutation(),
            catch: ensureError,
          });
        }),
      ),
  };
}

const FAILURE_MESSAGES: Readonly<Record<AgentFileCommand, string>> = {
  openAgentYaml: 'Failed to open agent YAML file',
  customizeAgent: 'Failed to create custom agent copy',
  deleteCustomAgent: 'Failed to delete custom agent',
  revealAgentFile: 'Failed to reveal agent file',
};

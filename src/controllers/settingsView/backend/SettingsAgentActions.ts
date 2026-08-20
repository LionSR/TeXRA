// Standard library imports
import * as path from 'node:path';

// Local imports - controllers
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
// Local imports - shared
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentSource, SettingsMessageFor } from '@shared/schemas';
// Local imports - utilities
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { isStrictlyWithin } from '@utils/core/pathCore';

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
  readonly revealFile: (filePath: string) => Promise<void>;
  readonly confirmAction: (
    message: string,
    confirmLabel: string,
  ) => Promise<boolean>;
  readonly showInfoMessage: (message: string) => Promise<void>;
  readonly showErrorMessage: (message: string) => Promise<void>;
  readonly formatOpenAgentYamlError: (
    reason: 'missingAgent' | 'missingPath',
    agentName: string,
  ) => string;
  readonly refreshAfterMutation: () => Promise<void>;
  readonly run: (
    command: AgentFileCommand,
    failureMessage: string,
    action: () => Promise<void>,
  ) => Promise<void>;
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
    action: () => Promise<void>,
  ): Promise<void> => options.run(command, FAILURE_MESSAGES[command], action);

  return {
    openAgentYaml: (message) =>
      run(message.command, async () => {
        const result = options.directoryController.planOpenAgentYaml({
          source: message.agentSource,
          name: message.agentName,
        });
        if (!result.ok) {
          await options.showErrorMessage(
            options.formatOpenAgentYamlError(result.reason, message.agentName),
          );
          return;
        }
        await options.openDocument(result.path);
      }),

    revealAgentFile: (message) =>
      run(message.command, async () => {
        const result = options.directoryController.planRevealAgentFile({
          source: message.agentSource,
          name: message.agentName,
        });
        if (!result.ok) {
          await options.showErrorMessage(
            `Agent not found or has no file: ${message.agentName}`,
          );
          return;
        }
        await options.revealFile(result.path);
      }),

    customizeAgent: (message) =>
      run(message.command, async () => {
        const entryPath = options.findAgent(
          message.agentSource,
          message.agentName,
        )?.path;
        if (!entryPath) {
          await options.showErrorMessage(
            `Agent not found or has no file: ${message.agentName}`,
          );
          return;
        }

        const [customDir, sourceDir] = await Promise.all([
          options.getCustomAgentDirectory(),
          options.getSourceDirectory(message.agentSource),
        ]);
        const relativePath = sourceDir
          ? path.relative(sourceDir, entryPath)
          : path.basename(entryPath);
        const targetPath = path.join(customDir, relativePath);
        if (!isStrictlyWithin(customDir, targetPath)) {
          await options.showErrorMessage(
            'Refusing to copy: target path escapes the custom agents directory.',
          );
          return;
        }

        await AbsoluteFS.ensureDir(path.dirname(targetPath));
        if (
          (await AbsoluteFS.exists(targetPath)) &&
          !(await options.confirmAction(
            `A custom copy already exists: ${path.basename(targetPath)}`,
            'Overwrite',
          ))
        ) {
          return;
        }

        await AbsoluteFS.copy(entryPath, targetPath, { overwrite: true });
        await options.openDocument(targetPath);
        await options.showInfoMessage(
          `Created custom copy: ${path.basename(targetPath)}`,
        );
        await options.refreshAfterMutation();
      }),

    deleteCustomAgent: (message) =>
      run(message.command, async () => {
        const entryPath = options.findAgent('custom', message.agentName)?.path;
        if (!entryPath) {
          await options.showErrorMessage(
            `Custom agent not found: ${message.agentName}`,
          );
          return;
        }

        const customDir = await options.getCustomAgentDirectory();
        if (!isStrictlyWithin(customDir, entryPath)) {
          await options.showErrorMessage(
            'Refusing to delete: file is not inside the custom agents directory.',
          );
          return;
        }

        if (
          !(await options.confirmAction(
            `Delete "${message.agentName}"? This cannot be undone.`,
            'Delete',
          ))
        ) {
          return;
        }

        await AbsoluteFS.delete(entryPath, { recursive: false });
        await options.showInfoMessage(
          `Deleted custom agent: ${message.agentName}`,
        );
        await options.refreshAfterMutation();
      }),
  };
}

const FAILURE_MESSAGES: Readonly<Record<AgentFileCommand, string>> = {
  openAgentYaml: 'Failed to open agent YAML file',
  customizeAgent: 'Failed to create custom agent copy',
  deleteCustomAgent: 'Failed to delete custom agent',
  revealAgentFile: 'Failed to reveal agent file',
};

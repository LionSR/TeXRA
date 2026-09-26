// Local imports
import { Effect } from 'effect';

import type { DesktopSettingsIpcOptions } from '@desktop/main/desktopSettingsIpc';
import type { DesktopToolingSettingsController } from '@desktop/main/desktopToolingSettingsController';
import { unsupported } from '@shared/utils/dispatcher';

const noOpEffect = (): Effect.Effect<void> => Effect.void;

/** Reads the `command` discriminant off a message posted to the renderer. */
export function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

/** Inert settings bindings; a test overrides the members it observes. */
export function createStubSettingsBindings(
  overrides: Partial<DesktopSettingsIpcOptions['bindings']> = {},
): DesktopSettingsIpcOptions['bindings'] {
  return {
    post: noOpEffect,
    notify: { showInfoMessage: noOpEffect, showErrorMessage: noOpEffect },
    prompt: {
      input: () => Effect.succeed(undefined),
      confirm: () => Effect.succeed(true),
      info: () => Effect.succeed(undefined),
      warning: () => Effect.succeed(undefined),
    },
    externalOpener: { openExternal: noOpEffect },
    openPath: noOpEffect,
    revealPath: noOpEffect,
    showReadOnlyYaml: noOpEffect,
    pickFolder: () => Effect.succeed(undefined),
    refreshCatalogs: noOpEffect,
    refreshCredentialStatus: Effect.void,
    createAgentWithAI: noOpEffect,
    customAgentDirChanged: Effect.void,
    remoteCatalog: {
      canAccess: () => Effect.succeed(false),
      signIn: () => Effect.succeed(false),
    },
    chooseTeamAvailability: () => Effect.succeed(undefined),
    revealRun: () => Effect.succeed('revealed'),
    runLabel: () => undefined,
    stateSettingApplied: noOpEffect,
    ...overrides,
  };
}

export function createStubDesktopToolingSettingsController(
  overrides: Partial<DesktopToolingSettingsController> = {},
): DesktopToolingSettingsController {
  return {
    toolHandlers: {
      installToolExtension: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      toggleTool: noOpEffect,
      runToolCommand: noOpEffect,
    },
    latexHandlers: {
      applyLatexSettings: unsupported(
        'Desktop cannot apply recommended VS Code settings.',
      ),
      installLatexWorkshop: unsupported(
        'Desktop cannot host VS Code extensions.',
      ),
      runInstallCommand: noOpEffect,
    },
    postStartupData: noOpEffect,
    followToolAvailability: Effect.void,
    ...overrides,
  };
}

// Local imports
import { Effect } from 'effect';

import type { DesktopSettingsIpcOptions } from '@desktop/main/desktopSettingsIpc';

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
    revealRun: () => Effect.succeed('revealed'),
    runLabel: () => undefined,
    stateSettingApplied: noOpEffect,
    runInTerminal: noOpEffect,
    latexEditorStatus: () => ({
      outDir: true,
      autoRevealExclude: true,
      latexWorkshopInstalled: false,
    }),
    ...overrides,
  };
}

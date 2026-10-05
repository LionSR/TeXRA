// Third-party imports
import { z } from 'zod';

// Local imports
import { API_KEY_PROVIDER_IDS, type ApiKeyProviderId } from '@texra-ai/llm';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  SettingsTargetSchema,
  type SettingsTarget,
} from '@texra/shared/settingsView/settingsViewMessages';
import {
  commandCatalog,
  settingsTabByCommand,
  type SettingsTabCommandId,
} from '@texra/shared/commands/catalog';
import {
  definedHandler,
  type CommandHandler,
} from '@texra/shared/commands/registry';
import type { Effect } from 'effect';

/**
 * This module is deliberately free of `vscode` imports (unlike
 * `extensionCommandSurface.ts`, which wires the real actions against VS
 * Code APIs) so it — and the catalog-derived types/handler map it
 * exports — can be imported directly from Vitest suites without a
 * `vscode` mock, the same way `packages/desktop/src/shared/desktopCommandSurface.ts`
 * is testable today.
 */

/**
 * Catalog ids whose extension registration is driven by the shared
 * `dispatchCommandFromRegistry` handler map below, derived from the
 * `extensionRegistry: true` tag on `commandCatalog` entries
 * (`packages/texra/src/shared/commands/catalog.ts`) rather than a hand-mirrored id list.
 * Adding a new registry-driven command only requires tagging its catalog
 * entry — `EXTENSION_COMMAND_HANDLERS` failing to `satisfy` its `Record<>`
 * constraint below is the compile-time signal that a handler still needs
 * to be authored (real per-command behavior can't be generated).
 */
type ExtensionRegistryCatalogEntry = Extract<
  (typeof commandCatalog)[number],
  { extensionRegistry: true }
>;

type ExtensionRegistryCatalogCommandId = ExtensionRegistryCatalogEntry['id'];

/**
 * `texra.openDoc` is intentionally absent from the shared catalog: it does not
 * appear in the command palette or `package.json` contributions, and takes a
 * page argument no palette invocation could supply.
 */
type ExtensionRegistryCommandId =
  ExtensionRegistryCatalogCommandId | 'texra.openDoc';

/**
 * A command's program. The registration boundary in
 * `extensionCommandSurface.ts` runs it once, over the session's rooted
 * filesystems, and settles `executeCommand` with its value.
 */
type CommandProgram<A = void> = Effect.Effect<
  A,
  Error,
  ProcessServices | WorkspaceFs | StorageFs
>;

/**
 * Capabilities the registry handlers need from the extension host. Mirrors
 * `DesktopCommandActions` in shape — both register parallel handler maps
 * over the same `CommandId` union with their host-specific actions.
 */
export interface ExtensionCommandActions {
  showSettings(tab?: SettingsTarget): CommandProgram;
  newTask(): CommandProgram;
  cleanBuild(): CommandProgram;
  signInChatGpt(): CommandProgram;
  runSetupAssistant(): CommandProgram;
  openGettingStarted(): CommandProgram;
  createSampleProject(): CommandProgram;
  downloadArXivSource(): CommandProgram;
  openProgressViewInTab(): CommandProgram;
  openDoc(page: string): CommandProgram;
  indentCurrentTeX(): CommandProgram;
  fixCompilation(): CommandProgram;
  getTeXCount(): CommandProgram;
  extractTikzFigures(): CommandProgram;
  compileTikzFigures(): CommandProgram;
  cloneOverleafProject(): CommandProgram;
  removeApiKey(): CommandProgram;
  showProgressView(inPlace: boolean): CommandProgram;
  setApiKey(provider: ApiKeyProviderId | undefined): CommandProgram;
  execute(input: unknown): CommandProgram;
}

/**
 * `texra.show*` rows derived from the catalog's `settingsTab` field so the
 * command → tab mapping lives in one place (`settingsTabByCommand`).
 */
const SETTINGS_TAB_COMMAND_HANDLERS = Object.fromEntries(
  (
    Object.entries(settingsTabByCommand) as [
      SettingsTabCommandId,
      SettingsTarget,
    ][]
  ).map(([id, tab]) => [
    id,
    (actions: ExtensionCommandActions) => actions.showSettings(tab),
  ]),
) as Record<
  SettingsTabCommandId,
  (actions: ExtensionCommandActions) => CommandProgram
>;

export const EXTENSION_COMMAND_HANDLERS = {
  ...SETTINGS_TAB_COMMAND_HANDLERS,
  // An optional target (`'models/keys'`) lets a caller land on one section.
  'texra.showDashboard': definedHandler(
    z.tuple([SettingsTargetSchema.optional()]),
    (actions: ExtensionCommandActions, target?: SettingsTarget) =>
      actions.showSettings(target),
  ),
  'texra.showMainView': (actions) => actions.newTask(),
  'texra.cleanBuild': (actions) => actions.cleanBuild(),
  'texra.auth.chatgpt.signIn': (actions) => actions.signInChatGpt(),
  [EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT]: (actions) =>
    actions.runSetupAssistant(),
  [EXTENSION_COMMANDS.OPEN_GETTING_STARTED]: (actions) =>
    actions.openGettingStarted(),
  [EXTENSION_COMMANDS.CREATE_SAMPLE_PROJECT]: (actions) =>
    actions.createSampleProject(),
  [EXTENSION_COMMANDS.DOWNLOAD_ARXIV_SOURCE]: (actions) =>
    actions.downloadArXivSource(),
  'texra.openProgressViewInTab': (actions) => actions.openProgressViewInTab(),
  'texra.openDoc': definedHandler(
    z.tuple([z.string()]),
    (actions: ExtensionCommandActions, page) => actions.openDoc(page),
  ),
  'texra.indentCurrentTeX': (actions) => actions.indentCurrentTeX(),
  'texra.fixCompilation': (actions) => actions.fixCompilation(),
  'texra.getTeXCount': (actions) => actions.getTeXCount(),
  'texra.extractTikzFigures': (actions) => actions.extractTikzFigures(),
  'texra.compileTikzFigures': (actions) => actions.compileTikzFigures(),
  [EXTENSION_COMMANDS.CLONE_OVERLEAF_PROJECT]: (actions) =>
    actions.cloneOverleafProject(),
  'texra.removeApiKey': (actions) => actions.removeApiKey(),
  'texra.showProgressView': definedHandler(
    z.tuple([z.strictObject({ inPlace: z.boolean().optional() }).optional()]),
    (actions: ExtensionCommandActions, options?: { inPlace?: boolean }) =>
      actions.showProgressView(options?.inPlace ?? false),
  ),
  'texra.setApiKey': definedHandler(
    z.tuple([z.enum(API_KEY_PROVIDER_IDS).optional()]),
    (actions: ExtensionCommandActions, provider?: ApiKeyProviderId) =>
      actions.setApiKey(provider),
  ),
  'texra.execute': definedHandler(
    z.tuple([z.unknown().optional()]),
    (actions: ExtensionCommandActions, input?: unknown) =>
      actions.execute(input),
  ),
} as const satisfies Record<
  ExtensionRegistryCommandId,
  // Typed handlers carry their own argument tuples via `definedHandler`.
  // Matching the registry map's per-entry TArgs widening (`any`) keeps
  // inference per entry without unifying every entry on `unknown`.
  CommandHandler<ExtensionCommandActions, any, CommandProgram<unknown>>
>;

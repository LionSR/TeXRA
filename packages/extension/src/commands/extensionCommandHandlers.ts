// Third-party imports
import { z } from 'zod';

// Local imports
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import {
  CleanConfigSchema,
  PackConfigSchema,
  type CleanConfig,
  type PackConfig,
} from '@commands/housekeeping/fileOpSchemas';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  AcceptCopyMetaSchema,
  AgentCategorySchema,
  FileLocationSchema,
  type AcceptCopyMeta,
  type AgentCategory,
  type FileLocation,
} from '@shared/schemas';
import {
  SettingsTargetSchema,
  type SettingsTarget,
} from '@shared/settingsView/settingsViewMessages';
import {
  commandCatalog,
  settingsTabByCommand,
  type SettingsTabCommandId,
} from '@shared/commands/catalog';
import { definedHandler, type CommandHandler } from '@shared/commands/registry';
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
 * (`src/shared/commands/catalog.ts`) rather than a hand-mirrored id list.
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
 * Internal ids intentionally absent from the shared catalog — they don't
 * appear in the command palette or `package.json` contributions — but must
 * keep resolving for extension callers. Each takes an argument no palette
 * invocation could supply.
 */
const EXTENSION_INTERNAL_COMMAND_IDS = [
  'texra.compare',
  'texra.acceptEdited',
  'texra.pack',
  'texra.clean',
  'texra.openDoc',
] as const;

type InternalExtensionRegistryCommandId =
  (typeof EXTENSION_INTERNAL_COMMAND_IDS)[number];

type ExtensionRegistryCommandId =
  ExtensionRegistryCatalogCommandId | InternalExtensionRegistryCommandId;

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
  showSettings(
    tab?: SettingsTarget,
    agentSubTab?: AgentCategory,
  ): CommandProgram;
  newTask(): CommandProgram;
  cleanBuild(): CommandProgram;
  pack(config: PackConfig): CommandProgram;
  clean(config: CleanConfig): CommandProgram;
  compare(
    baseLocation: FileLocation,
    editedLocation: FileLocation,
  ): CommandProgram;
  acceptEdited(
    baseLocation: FileLocation,
    editedLocation: FileLocation,
    copyMeta?: AcceptCopyMeta,
  ): CommandProgram<boolean>;
  signIn(): CommandProgram<boolean>;
  signInChatGpt(): CommandProgram;
  signOut(): CommandProgram;
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
  setApiKey(provider: ApiProvider | undefined): CommandProgram;
  createAgentWithAI(category: AgentCategory): CommandProgram;
  execute(input: unknown): CommandProgram;
}

/**
 * `texra.show*` rows derived from the catalog's `settingsTab` field so the
 * command → tab mapping lives in one place (`settingsTabByCommand`).
 * `texra.showAgents` is re-declared below: it additionally accepts an
 * agent-category sub-tab argument.
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
  'texra.pack': definedHandler(
    z.tuple([PackConfigSchema]),
    (actions: ExtensionCommandActions, config) => actions.pack(config),
  ),
  'texra.clean': definedHandler(
    z.tuple([CleanConfigSchema]),
    (actions: ExtensionCommandActions, config) => actions.clean(config),
  ),
  'texra.compare': definedHandler(
    z.tuple([FileLocationSchema, FileLocationSchema]),
    (actions: ExtensionCommandActions, baseLocation, editedLocation) =>
      actions.compare(baseLocation, editedLocation),
  ),
  'texra.acceptEdited': definedHandler(
    z.tuple([
      FileLocationSchema,
      FileLocationSchema,
      AcceptCopyMetaSchema.optional(),
    ]),
    (
      actions: ExtensionCommandActions,
      baseLocation,
      editedLocation,
      copyMeta?: AcceptCopyMeta,
    ) => actions.acceptEdited(baseLocation, editedLocation, copyMeta),
  ),
  'texra.auth.signIn': (actions) => actions.signIn(),
  'texra.auth.chatgpt.signIn': (actions) => actions.signInChatGpt(),
  'texra.auth.signOut': (actions) => actions.signOut(),
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
    z.tuple([z.enum(API_PROVIDERS).optional()]),
    (actions: ExtensionCommandActions, provider?: ApiProvider) =>
      actions.setApiKey(provider),
  ),
  'texra.createAgentWithAI': definedHandler(
    z.tuple([AgentCategorySchema.optional()]),
    (actions: ExtensionCommandActions, category?: AgentCategory) =>
      actions.createAgentWithAI(category ?? 'workflow'),
  ),
  'texra.execute': definedHandler(
    z.tuple([z.unknown().optional()]),
    (actions: ExtensionCommandActions, input?: unknown) =>
      actions.execute(input),
  ),
  'texra.showAgents': definedHandler(
    z.tuple([AgentCategorySchema.optional()]),
    (actions: ExtensionCommandActions, subTab?: AgentCategory) =>
      actions.showSettings(settingsTabByCommand['texra.showAgents'], subTab),
  ),
} as const satisfies Record<
  ExtensionRegistryCommandId,
  // Typed handlers carry their own argument tuples via `definedHandler`.
  // Matching the registry map's per-entry TArgs widening (`any`) keeps
  // inference per entry without unifying every entry on `unknown`.
  CommandHandler<ExtensionCommandActions, any, CommandProgram<unknown>>
>;

// Third-party imports
import { z } from 'zod';

// Local imports
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import {
  CleanConfigSchema,
  CleanMultipleCommandArgsSchema,
  FileOpCommandArgsSchema,
  PackConfigSchema,
  PackMultipleCommandArgsSchema,
  type CleanConfig,
  type PackConfig,
} from '@commands/housekeeping/fileOpSchemas';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import { commandCatalog } from '@shared/commands/catalog';
import {
  awaitTrue,
  definedHandler,
  type CommandHandler,
} from '@shared/commands/registry';
import { AgentCategorySchema, type AgentCategory } from '@shared/schemas/agent';
import { StreamTabIdSchema } from '@shared/schemas/identifiers';
import {
  AcceptCopyMetaSchema,
  FileLocationSchema,
  type AcceptCopyMeta,
  type FileLocation,
} from '@shared/schemas/output';
import {
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';

/**
 * This module is deliberately free of `vscode` imports (unlike
 * `extensionCommandSurface.ts`, which wires the real actions against VS
 * Code APIs) so it — and the catalog-derived types/handler map it
 * exports — can be imported directly from Vitest suites without a
 * `vscode` mock, the same way `packages/desktop/src/shared/desktopCommandSurface.ts`
 * is testable today.
 */

/**
 * Optional `ApiProvider` argument for `texra.setApiKey`. The tuple's single
 * element is optional, so the registry's `safeParse` succeeds when the command
 * is invoked from the palette without arguments — the action then prompts the
 * user via `showQuickPick`.
 */
const SetApiKeyArgsSchema = z.tuple([z.enum(API_PROVIDERS).optional()]);

/**
 * Optional `AgentCategory` argument for `texra.createAgentWithAI`. The
 * registry parses raw `unknown` and the action defaults to `workflow`
 * when undefined (preserving the legacy `category ?? 'workflow'` shape).
 */
const CreateAgentWithAIArgsSchema = z.tuple([AgentCategorySchema.optional()]);

/**
 * Optional `AgentCategory` argument for `texra.showAgents`, selecting which
 * agent-category sub-tab opens under Settings > Agents.
 */
const ShowAgentsArgsSchema = z.tuple([AgentCategorySchema.optional()]);

/** Optional placement argument for `texra.showProgressView`. */
const ShowProgressViewArgsSchema = z.tuple([
  z.strictObject({ inPlace: z.boolean().optional() }).optional(),
]);

/** Positional arguments for opening a comparison between two files. */
const CompareCommandArgsSchema = z
  .tuple([
    FileLocationSchema.nullish(),
    FileLocationSchema.nullish(),
    FileLocationSchema,
  ])
  .refine(
    ([inputLocation, baseLocation]) =>
      inputLocation != null || baseLocation != null,
    { error: 'inputLocation or baseLocation required' },
  );

/** Positional arguments for accepting an edited file. */
const AcceptEditedCommandArgsSchema = z
  .tuple([
    FileLocationSchema.nullish(),
    FileLocationSchema.nullish(),
    FileLocationSchema,
    AcceptCopyMetaSchema.optional(),
  ])
  .refine(
    ([inputLocation, baseLocation]) =>
      inputLocation != null || baseLocation != null,
    { error: 'inputLocation or baseLocation required' },
  );

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
 * Internal and compatibility ids intentionally absent from the shared
 * catalog — they don't appear in the command palette or `package.json`
 * contributions — but must keep resolving for extension callers.
 */
export const EXTENSION_INTERNAL_COMMAND_IDS = [
  'texra.showSettingsView',
  'texra.packSingle',
  'texra.packMultiple',
  'texra.cleanSingle',
  'texra.cleanMultiple',
  'texra.compare',
  'texra.acceptEdited',
] as const;

type InternalExtensionRegistryCommandId =
  (typeof EXTENSION_INTERNAL_COMMAND_IDS)[number];

type OptionalFileLocation = FileLocation | null | undefined;

export type ExtensionRegistryCommandId =
  ExtensionRegistryCatalogCommandId | InternalExtensionRegistryCommandId;

/**
 * Runtime mirror of `ExtensionRegistryCatalogCommandId`, used by tests to
 * assert `EXTENSION_COMMAND_HANDLERS` registers every catalog entry tagged
 * `extensionRegistry: true` (and flag strays that no longer belong).
 */
export const EXTENSION_REGISTRY_CATALOG_COMMAND_IDS: readonly ExtensionRegistryCatalogCommandId[] =
  commandCatalog
    .filter(
      (entry): entry is ExtensionRegistryCatalogEntry =>
        'extensionRegistry' in entry && entry.extensionRegistry === true,
    )
    .map((entry) => entry.id);

/**
 * Capabilities the registry handlers need from the extension host. Mirrors
 * `DesktopCommandActions` in shape — both register parallel handler maps
 * over the same `CommandId` union with their host-specific actions.
 */
export interface ExtensionCommandActions {
  showSettings(
    tabIndex?: SettingsTab,
    agentSubTab?: AgentCategory,
  ): Promise<void>;
  resetMainView(): Promise<void>;
  cleanBuild(): Promise<void>;
  cleanOutput(): Promise<void>;
  pack(config: PackConfig): Promise<void>;
  packSingle(inputFile: string, agent: string, model: string): Promise<void>;
  packMultiple(
    inputFile: string,
    agent: string,
    model: string,
    inputFiles: string[],
  ): Promise<void>;
  clean(config: CleanConfig): Promise<void>;
  cleanSingle(inputFile: string, agent: string, model: string): Promise<void>;
  cleanMultiple(
    inputFile: string,
    agent: string,
    model: string,
    inputFiles: string[],
  ): Promise<void>;
  compare(
    inputLocation: OptionalFileLocation,
    baseLocation: OptionalFileLocation,
    editedLocation: FileLocation,
  ): Promise<void>;
  acceptEdited(
    inputLocation: OptionalFileLocation,
    baseLocation: OptionalFileLocation,
    editedLocation: FileLocation,
    copyMeta?: AcceptCopyMeta,
  ): Promise<boolean>;
  indentTeX(): Promise<void>;
  signIn(): Promise<boolean>;
  signInChatGpt(): Promise<void>;
  signInGrok(): Promise<boolean>;
  signOut(): Promise<void>;
  runSetupAssistant(): Promise<void>;
  openGettingStarted(): Thenable<unknown>;
  createSampleProject(): Promise<void>;
  downloadArXivSource(): Promise<void>;
  openProgressViewInTab(): Promise<void>;
  openDoc(page: string): Promise<void>;
  stopAgent(streamId: string): void;
  compactResponse(streamId: string): Promise<void>;
  indentCurrentTeX(): Promise<void>;
  fixCompilation(): Promise<void>;
  getTeXCount(): Promise<void>;
  extractTikzFigures(): Promise<void>;
  compileTikzFigures(): Promise<void>;
  cloneOverleafProject(): Promise<void>;
  // Batch 4 (#3781).
  removeApiKey(): Promise<void>;
  showImportOptions(): Promise<void>;
  toggleView(): Promise<void>;
  showProgressView(inPlace: boolean): Promise<void>;
  setApiKey(provider: ApiProvider | undefined): Promise<void>;
  createAgentWithAI(category: AgentCategory): Promise<void>;
  execute(input: unknown): Promise<void>;
}

export const EXTENSION_COMMAND_HANDLERS = {
  'texra.showDashboard': (actions) => awaitTrue(actions.showSettings()),
  'texra.showSettingsView': (actions) => awaitTrue(actions.showSettings()),
  'texra.showMemory': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.MEMORY)),
  'texra.showAgentHistory': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.HISTORY)),
  'texra.showModels': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.MODELS)),
  'texra.showTools': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.TOOLS)),
  'texra.showMultiAgent': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.MULTI_AGENT)),
  'texra.showGitSettings': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.GIT)),
  'texra.mainView.reset': (actions) => awaitTrue(actions.resetMainView()),
  'texra.cleanOutput': (actions) => awaitTrue(actions.cleanOutput()),
  'texra.cleanBuild': (actions) => awaitTrue(actions.cleanBuild()),
  'texra.pack': definedHandler(
    z.tuple([PackConfigSchema]),
    (actions: ExtensionCommandActions, config) =>
      awaitTrue(actions.pack(config)),
  ),
  'texra.packSingle': definedHandler(
    FileOpCommandArgsSchema,
    (actions: ExtensionCommandActions, inputFile, agent, model) =>
      awaitTrue(actions.packSingle(inputFile, agent, model)),
  ),
  'texra.packMultiple': definedHandler(
    PackMultipleCommandArgsSchema,
    (actions: ExtensionCommandActions, inputFile, agent, model, inputFiles) =>
      awaitTrue(actions.packMultiple(inputFile, agent, model, inputFiles)),
  ),
  'texra.clean': definedHandler(
    z.tuple([CleanConfigSchema]),
    (actions: ExtensionCommandActions, config) =>
      awaitTrue(actions.clean(config)),
  ),
  'texra.cleanSingle': definedHandler(
    FileOpCommandArgsSchema,
    (actions: ExtensionCommandActions, inputFile, agent, model) =>
      awaitTrue(actions.cleanSingle(inputFile, agent, model)),
  ),
  'texra.cleanMultiple': definedHandler(
    CleanMultipleCommandArgsSchema,
    (actions: ExtensionCommandActions, inputFile, agent, model, inputFiles) =>
      awaitTrue(actions.cleanMultiple(inputFile, agent, model, inputFiles)),
  ),
  'texra.compare': definedHandler(
    CompareCommandArgsSchema,
    (
      actions: ExtensionCommandActions,
      inputLocation,
      baseLocation,
      editedLocation,
    ) =>
      awaitTrue(actions.compare(inputLocation, baseLocation, editedLocation)),
  ),
  'texra.acceptEdited': definedHandler(
    AcceptEditedCommandArgsSchema,
    (
      actions: ExtensionCommandActions,
      inputLocation,
      baseLocation,
      editedLocation,
      copyMeta?: AcceptCopyMeta,
    ) =>
      actions.acceptEdited(
        inputLocation,
        baseLocation,
        editedLocation,
        copyMeta,
      ),
  ),
  'texra.indentTeX': (actions) => awaitTrue(actions.indentTeX()),
  'texra.auth.signIn': (actions) => awaitTrue(actions.signIn()),
  'texra.auth.chatgpt.signIn': (actions) => awaitTrue(actions.signInChatGpt()),
  'texra.auth.grok.signIn': (actions) => awaitTrue(actions.signInGrok()),
  'texra.auth.signOut': (actions) => awaitTrue(actions.signOut()),
  'texra.auth.viewProfile': (actions) =>
    awaitTrue(actions.showSettings(SETTINGS_TAB.ACCOUNT)),
  [EXTENSION_COMMANDS.RUN_SETUP_ASSISTANT]: (actions) =>
    awaitTrue(actions.runSetupAssistant()),
  [EXTENSION_COMMANDS.OPEN_GETTING_STARTED]: (actions) =>
    awaitTrue(actions.openGettingStarted()),
  [EXTENSION_COMMANDS.CREATE_SAMPLE_PROJECT]: (actions) =>
    awaitTrue(actions.createSampleProject()),
  [EXTENSION_COMMANDS.DOWNLOAD_ARXIV_SOURCE]: (actions) =>
    awaitTrue(actions.downloadArXivSource()),
  'texra.openProgressViewInTab': (actions) =>
    awaitTrue(actions.openProgressViewInTab()),
  'texra.openDoc': definedHandler(
    z.tuple([z.string()]),
    (actions: ExtensionCommandActions, page) =>
      awaitTrue(actions.openDoc(page)),
  ),
  'texra.stopAgent': definedHandler(
    z.tuple([StreamTabIdSchema]),
    (actions: ExtensionCommandActions, streamId) => {
      actions.stopAgent(streamId);
      return true;
    },
  ),
  'texra.compactResponse': definedHandler(
    z.tuple([StreamTabIdSchema]),
    (actions: ExtensionCommandActions, streamId) =>
      awaitTrue(actions.compactResponse(streamId)),
  ),
  'texra.indentCurrentTeX': (actions) => awaitTrue(actions.indentCurrentTeX()),
  'texra.fixCompilation': (actions) => awaitTrue(actions.fixCompilation()),
  'texra.getTeXCount': (actions) => awaitTrue(actions.getTeXCount()),
  'texra.extractTikzFigures': (actions) =>
    awaitTrue(actions.extractTikzFigures()),
  'texra.compileTikzFigures': (actions) =>
    awaitTrue(actions.compileTikzFigures()),
  [EXTENSION_COMMANDS.CLONE_OVERLEAF_PROJECT]: (actions) =>
    awaitTrue(actions.cloneOverleafProject()),
  // Batch 4 (#3781).
  'texra.removeApiKey': (actions) => awaitTrue(actions.removeApiKey()),
  'texra.showImportOptions': (actions) =>
    awaitTrue(actions.showImportOptions()),
  'texra.toggleView': (actions) => awaitTrue(actions.toggleView()),
  'texra.showProgressView': definedHandler(
    ShowProgressViewArgsSchema,
    (actions: ExtensionCommandActions, options?: { inPlace?: boolean }) =>
      awaitTrue(actions.showProgressView(options?.inPlace ?? false)),
  ),
  'texra.setApiKey': definedHandler(
    SetApiKeyArgsSchema,
    (actions: ExtensionCommandActions, provider?: ApiProvider) =>
      awaitTrue(actions.setApiKey(provider)),
  ),
  'texra.createAgentWithAI': definedHandler(
    CreateAgentWithAIArgsSchema,
    (actions: ExtensionCommandActions, category?: AgentCategory) =>
      awaitTrue(actions.createAgentWithAI(category ?? 'workflow')),
  ),
  'texra.execute': definedHandler(
    z.tuple([z.unknown().optional()]),
    (actions: ExtensionCommandActions, input?: unknown) =>
      awaitTrue(actions.execute(input)),
  ),
  'texra.showAgents': definedHandler(
    ShowAgentsArgsSchema,
    (actions: ExtensionCommandActions, subTab?: AgentCategory) =>
      awaitTrue(actions.showSettings(SETTINGS_TAB.AGENTS, subTab)),
  ),
} as const satisfies Record<
  ExtensionRegistryCommandId,
  // Typed handlers carry their own argument tuples via `definedHandler`.
  // Matching the registry map's per-entry TArgs widening (`any`) keeps
  // inference per entry without unifying every entry on `unknown`.
  CommandHandler<ExtensionCommandActions, any>
>;

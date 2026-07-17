// Third-party imports
import { z } from 'zod';

// Local imports
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
  SETTINGS_TAB,
  type SettingsTab,
} from '@shared/schemas/settingsViewMessages';

/**
 * This module is deliberately free of `vscode` imports (unlike
 * `extensionCommandSurface.ts`, which wires the real actions against VS
 * Code APIs) so it — and the catalog-derived types/handler map it
 * exports — can be imported directly from Vitest suites without a
 * `vscode` mock, the same way `packages/desktop/src/desktopCommandSurface.ts`
 * is testable today.
 */

/**
 * Optional `ApiProvider` argument for `texra.setApiKey`. The schema accepts
 * `undefined` so the registry's `safeParse` succeeds when the command is
 * invoked from the palette without arguments — the action then prompts the
 * user via `showQuickPick`.
 */
const SetApiKeyArgSchema = z.enum(API_PROVIDERS).optional();

/**
 * Optional `AgentCategory` argument for `texra.createAgentWithAI`. The
 * registry parses raw `unknown` and the action defaults to `workflow`
 * when undefined (preserving the legacy `category ?? 'workflow'` shape).
 */
const CreateAgentWithAIArgSchema = AgentCategorySchema.optional();

/**
 * Optional `{ inPlace }` argument for `texra.showProgressView`. The
 * legacy registration accepted any argument shape and only honoured the
 * `inPlace` boolean — `z.unknown()` here preserves that best-effort
 * semantics so callers passing `null`, booleans, or stringified flags
 * still open the progress view (just without the in-place flag) instead
 * of being rejected by the dispatcher as unhandled.
 */
const ShowProgressViewArgSchema = z.unknown();

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

export type ExtensionRegistryCatalogCommandId =
  ExtensionRegistryCatalogEntry['id'];

/**
 * Compatibility ids intentionally absent from the shared catalog — they
 * don't appear in the command palette or `package.json` contributions —
 * but must keep resolving for existing callers (e.g. stored keybindings,
 * webview postMessage payloads).
 */
export const EXTENSION_HIDDEN_ALIASES = ['texra.showSettingsView'] as const;

type HiddenExtensionRegistryCommandId =
  (typeof EXTENSION_HIDDEN_ALIASES)[number];

export type ExtensionRegistryCommandId =
  ExtensionRegistryCatalogCommandId | HiddenExtensionRegistryCommandId;

/**
 * Runtime mirror of `ExtensionRegistryCatalogCommandId`, used by tests to
 * assert `EXTENSION_COMMAND_HANDLERS` / `EXTENSION_PARAMETERIZED_HANDLERS`
 * register every catalog entry tagged `extensionRegistry: true` (and flag
 * strays that no longer belong).
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
  openWorkbenchSettings(): Thenable<unknown>;
  cleanBuild(): Promise<void>;
  cleanOutput(): Promise<void>;
  indentTeX(): Promise<void>;
  signIn(): Promise<boolean>;
  signInChatGpt(): Promise<boolean>;
  signInKimiCode(): Promise<boolean>;
  signOut(): Promise<void>;
  viewProfile(): Promise<void>;
  runSetupAssistant(): Promise<void>;
  openGettingStarted(): Thenable<unknown>;
  createSampleProject(): Promise<void>;
  downloadArXivSource(): Promise<void>;
  testConnection(): Promise<void>;
  testAgentLoading(): Promise<void>;
  loadSpecificAgent(): Promise<void>;
  openProgressViewInTab(): Promise<void>;
  openDoc(page: string): Promise<void>;
  stopAgent(streamId: string): void;
  compactResponse(streamId: string): Promise<void>;
  parseXml(): Promise<void>;
  parseYaml(): Promise<void>;
  testTextEditor(): Promise<void>;
  indentCurrentTeX(): Promise<void>;
  applyReplacements(): Promise<void>;
  fixCompilation(): Promise<void>;
  getTeXCount(): Promise<void>;
  countPdfPages(): Promise<void>;
  showLinterMessages(): Promise<void>;
  countLinterMessages(): Promise<void>;
  extractFigurePaths(): Promise<void>;
  // Batch 3 (#3781). The action functions return data (the underlying
  // `string | string[] | undefined`) for direct callers, but the
  // registry's typed return is `Promise<boolean>`, so the dispatcher
  // wraps them with `awaitTrue(...)` and the resolved data is
  // intentionally dropped. Palette / `executeCommand` callers don't
  // consume the value today; if a future caller needs the original
  // payload it must call the action helper directly instead of going
  // through `vscode.commands.executeCommand`.
  encodeImageToBase64(): Promise<string | undefined>;
  convertPdfToImages(): Promise<string[] | string | undefined>;
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
  'texra.openSettings': (actions) => awaitTrue(actions.openWorkbenchSettings()),
  'texra.mainView.reset': (actions) => awaitTrue(actions.resetMainView()),
  'texra.cleanOutput': (actions) => awaitTrue(actions.cleanOutput()),
  'texra.cleanBuild': (actions) => awaitTrue(actions.cleanBuild()),
  'texra.indentTeX': (actions) => awaitTrue(actions.indentTeX()),
  'texra.auth.signIn': (actions) => awaitTrue(actions.signIn()),
  'texra.auth.chatgpt.signIn': (actions) => awaitTrue(actions.signInChatGpt()),
  'texra.auth.kimiCode.signIn': (actions) =>
    awaitTrue(actions.signInKimiCode()),
  'texra.auth.signOut': (actions) => awaitTrue(actions.signOut()),
  'texra.auth.viewProfile': (actions) => awaitTrue(actions.viewProfile()),
  'texra.runSetupAssistant': (actions) =>
    awaitTrue(actions.runSetupAssistant()),
  'texra.openGettingStarted': (actions) =>
    awaitTrue(actions.openGettingStarted()),
  'texra.createSampleProject': (actions) =>
    awaitTrue(actions.createSampleProject()),
  'texra.downloadArXivSource': (actions) =>
    awaitTrue(actions.downloadArXivSource()),
  'texra.testConnection': (actions) => awaitTrue(actions.testConnection()),
  'texra.testAgentLoading': (actions) => awaitTrue(actions.testAgentLoading()),
  'texra.loadSpecificAgent': (actions) =>
    awaitTrue(actions.loadSpecificAgent()),
  'texra.openProgressViewInTab': (actions) =>
    awaitTrue(actions.openProgressViewInTab()),
  'texra.openDoc': definedHandler(
    z.string(),
    (actions: ExtensionCommandActions, page) =>
      awaitTrue(actions.openDoc(page)),
  ),
  'texra.stopAgent': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) => {
      actions.stopAgent(streamId);
      return true;
    },
  ),
  'texra.compactResponse': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) =>
      awaitTrue(actions.compactResponse(streamId)),
  ),
  'texra.parseXml': (actions) => awaitTrue(actions.parseXml()),
  'texra.parseYaml': (actions) => awaitTrue(actions.parseYaml()),
  'texra.testTextEditor': (actions) => awaitTrue(actions.testTextEditor()),
  'texra.indentCurrentTeX': (actions) => awaitTrue(actions.indentCurrentTeX()),
  'texra.applyReplacements': (actions) =>
    awaitTrue(actions.applyReplacements()),
  'texra.fixCompilation': (actions) => awaitTrue(actions.fixCompilation()),
  'texra.getTeXCount': (actions) => awaitTrue(actions.getTeXCount()),
  'texra.countPdfPages': (actions) => awaitTrue(actions.countPdfPages()),
  'texra.showLinterMessages': (actions) =>
    awaitTrue(actions.showLinterMessages()),
  'texra.countLinterMessages': (actions) =>
    awaitTrue(actions.countLinterMessages()),
  'texra.extractFigurePaths': (actions) =>
    awaitTrue(actions.extractFigurePaths()),
  // Batch 3 (#3781) — image / PDF / TikZ / Overleaf entry points.
  'texra.encodeImageToBase64': (actions) =>
    awaitTrue(actions.encodeImageToBase64()),
  'texra.convertPdfToImages': (actions) =>
    awaitTrue(actions.convertPdfToImages()),
  'texra.extractTikzFigures': (actions) =>
    awaitTrue(actions.extractTikzFigures()),
  'texra.compileTikzFigures': (actions) =>
    awaitTrue(actions.compileTikzFigures()),
  'texra.cloneOverleafProject': (actions) =>
    awaitTrue(actions.cloneOverleafProject()),
  // Batch 4 (#3781).
  'texra.removeApiKey': (actions) => awaitTrue(actions.removeApiKey()),
  'texra.showImportOptions': (actions) =>
    awaitTrue(actions.showImportOptions()),
  'texra.toggleView': (actions) => awaitTrue(actions.toggleView()),
  'texra.showProgressView': definedHandler(
    ShowProgressViewArgSchema,
    (actions: ExtensionCommandActions, parsed) => {
      const inPlace =
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { inPlace?: unknown }).inPlace === true;
      return awaitTrue(actions.showProgressView(inPlace));
    },
  ),
  'texra.setApiKey': definedHandler(
    SetApiKeyArgSchema,
    (actions: ExtensionCommandActions, provider) =>
      awaitTrue(actions.setApiKey(provider)),
  ),
  'texra.createAgentWithAI': definedHandler(
    CreateAgentWithAIArgSchema,
    (actions: ExtensionCommandActions, category) =>
      awaitTrue(actions.createAgentWithAI(category ?? 'workflow')),
  ),
  'texra.execute': definedHandler(
    z.unknown(),
    (actions: ExtensionCommandActions, input) =>
      awaitTrue(actions.execute(input)),
  ),
} as const satisfies Record<
  Exclude<ExtensionRegistryCommandId, 'texra.showAgents'>,
  // The typed handlers (`openDoc`, `stopAgent`, `compactResponse`) carry
  // their own argument shapes via `definedHandler`. Matching the registry
  // map's per-entry TArgs widening (`any`) keeps inference per entry
  // without unifying every entry on `unknown`.
  CommandHandler<ExtensionCommandActions, any>
>;

// `texra.showAgents` accepts an optional `AgentCategory` argument from
// `executeCommand` callers, so it can't share the no-arg `CommandHandler`
// signature. It's still routed through the same actions interface — the
// only difference is that the VS Code registration forwards the argument.
//
// FOLLOW_UP: This bespoke parameterized map can be replaced with the
// `definedHandler` typed-args helper in `@shared/commands/registry` once
// the surrounding parameterized commands (pack/clean/compare/etc.) are
// migrated through that path. Keeping it as-is for now to minimize churn.
export const EXTENSION_PARAMETERIZED_HANDLERS = {
  'texra.showAgents': (actions, subTab?: AgentCategory) =>
    actions.showSettings(SETTINGS_TAB.AGENTS, subTab),
} satisfies Record<
  Extract<ExtensionRegistryCommandId, 'texra.showAgents'>,
  (actions: ExtensionCommandActions, arg?: AgentCategory) => Promise<void>
>;

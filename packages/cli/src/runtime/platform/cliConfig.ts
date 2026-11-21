// Third-party imports
import { Effect, Predicate, Result, Schema, type Types } from 'effect';

// Local imports - platform
import { modelConfig, MODELS } from '@texra-ai/llm';
import { mcpConfigPathOf, readMcpConfig } from '@texra-ai/harness/host';
import {
  Settings,
  type SettingsStores,
  type ConfigProvider,
} from '@texra-ai/harness/plugins';
import type { SettingRow } from '@texra-ai/harness/schemas';
import {
  JsonConfigProvider,
  nodeFileServices,
  type JsonStore,
} from '@texra-ai/harness/node';

// Local imports - shared
import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import { isImplicitDefaultEligible } from '@texra/shared/constants/agents';
import { openTexraConfigStores } from '@texra/platform/defaults/nodeStores';
import {
  CLI_AGENT_SETTING,
  CLI_CHAT_SETTING,
  CLI_MODEL_SETTING,
  CLI_RUN_SETTING,
  TEXRA_SETTINGS,
} from '@texra/shared/settings/texraSettings';

// Local imports - tools

// Local imports - utilities

/**
 * The model a `texra` command starts on when nothing else names one.
 *
 * A deliberate cheap-start choice, not a recommendation: the terminal client
 * is the surface someone tries first, often with one freshly pasted provider
 * key, so the built-in default is the cheapest capable model rather than the
 * strongest. `--model`, `TEXRA_MODEL`, and the `texra.model` /
 * `texra.chat.model` / `texra.run.model` rows all outrank it, and a model this
 * machine cannot run falls back to an available one with a notice.
 */
export const CLI_CHEAP_START_MODEL = 'deepseek/deepseek-v4-pro';

/** The `texra.*` command sections: `texra.chat` and `texra.run`. */
const COMMAND_SECTIONS = {
  chat: CLI_CHAT_SETTING,
  run: CLI_RUN_SETTING,
} as const;
type CliCommandRole = keyof typeof COMMAND_SECTIONS;

/**
 * Agent and model for one command, after the section/top-level fallthrough:
 * the members of the widest section, `texra.chat`.
 */
type CliCommandDefaults = NonNullable<typeof CLI_CHAT_SETTING.schema.Type>;

function normalizeCliModelLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');
}

function modelLookupKeys(id: string): string[] {
  const config = modelConfig(id);
  return [id, config?.id, config?.label].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * The model string a CLI argument names: a model reference with optional
 * `@effort`/`+pro` as given, or an unambiguous spelling of a model's API id or label
 * (`grok-4.7`, `Opus 5.5`).
 */
export function resolveKnownCliModelId(model: string): string | undefined {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  if (modelConfig(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  const ids = MODELS;
  const exactIdMatch = ids.find((id) => id.toLowerCase() === lower);
  if (exactIdMatch) return exactIdMatch;

  const exactTextMatches = ids.filter((id) =>
    modelLookupKeys(id).some((key) => key.toLowerCase() === lower),
  );
  if (exactTextMatches.length === 1) return exactTextMatches[0];
  if (exactTextMatches.length > 1) return undefined;

  const normalized = normalizeCliModelLookupKey(trimmed);
  if (!normalized) return undefined;
  const normalizedMatches = ids.filter((id) =>
    modelLookupKeys(id).some(
      (key) => normalizeCliModelLookupKey(key) === normalized,
    ),
  );
  return normalizedMatches.length === 1 ? normalizedMatches[0] : undefined;
}

/** The process's config provider, plus the workspace file's diagnostics. */
export interface CliStartupConfig {
  /**
   * The one provider of this process: `buildCliContext` resolves the startup
   * rows through it and `CliPlatform` installs this same instance as the
   * workspace roots' config, so a value `texra config` writes is the value the
   * next run reads.
   */
  readonly config: ConfigProvider;
  /** The routine config problems only the CLI reads (its command sections,
   *  its MCP server file), for the CLI and `texra doctor`. */
  readonly warnings: readonly string[];
  /**
   * What the shared open found: a config file that could not be used at all
   * (malformed JSON, not an object), and entries that cannot apply (an
   * unknown project key, a rejected value, a key a project cannot set).
   * Actionable degradation, not routine noise, so it is printed even under
   * `--quiet`.
   */
  readonly degradations: readonly string[];
}

/**
 * An agent named by configuration or the environment, trimmed, or undefined
 * when it may not be started on implicitly: `simplifier` set as the chat
 * agent is ignored rather than auto-selected. An explicit `--agent` is
 * honored as given and never passes through here.
 */
export function usableDefaultAgent(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isImplicitDefaultEligible(trimmed) ? trimmed : undefined;
}

/**
 * Agent and model for one command: its own `texra.chat` / `texra.run` section
 * over the top-level `texra.agent` / `texra.model` rows, both resolved through
 * the setting slots the caller holds — the ones `CliPlatform` handed back,
 * so the value read here is the value `texra config` writes. The agent is
 * the one a launch would start on (`usableDefaultAgent`), so what `texra
 * agents` shows as the default is what the chat starts.
 */
export function cliCommandDefaults(
  stores: SettingsStores,
  role: CliCommandRole,
): CliCommandDefaults {
  const sectionRow: SettingRow<CliCommandDefaults | undefined> =
    COMMAND_SECTIONS[role];
  const section = Settings.getConfig(stores.config, sectionRow) ?? {};
  return {
    agent: usableDefaultAgent(
      section.agent ?? Settings.getConfig(stores.config, CLI_AGENT_SETTING),
    ),
    model:
      section.model ?? Settings.getConfig(stores.config, CLI_MODEL_SETTING),
  };
}

/**
 * Update the workspace chat-agent default without replacing unrelated config.
 * Nested command defaults remain a JSON object under the canonical `texra.chat`
 * key, written through the catalog's own write path so the row's schema
 * validates it and the write lands in the store this process reads back.
 */
export const setWorkspaceCliChatAgent = Effect.fn(
  'cliConfig.setWorkspaceCliChatAgent',
)(function* (stores: SettingsStores, agent: string | undefined) {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    return yield* new SettingsRequestFailed({
      message: 'The default chat agent must not be empty.',
    });
  }
  // The workspace file's own section, not the merged read: the write below
  // lands in the workspace target, so seeding from `workspace over user` would
  // copy a user-level `texra.chat.model` into the project file and pin it
  // above every later user-level edit.
  // A section its row rejects (a string, an array) seeds nothing.
  const stored = stores.config.inspect<unknown>(
    CLI_CHAT_SETTING.key,
  ).workspaceValue;
  const next: Types.Mutable<CliCommandDefaults> = Predicate.isObject(stored)
    ? { ...stored }
    : {};
  if (trimmed) next.agent = trimmed;
  else delete next.agent;
  yield* Settings.set(
    stores,
    CLI_CHAT_SETTING,
    Object.keys(next).length > 0 ? next : undefined,
  );
});

/** The `texra.chat` / `texra.run` rows, each with the members it accepts.
 *  `texra run` takes its agent as a required argument, so its section sets
 *  only the model. */
const COMMAND_SECTION_MEMBERS = [CLI_CHAT_SETTING, CLI_RUN_SETTING].map(
  (row) =>
    [row, new Set(Object.keys(Schema.required(row.schema).fields))] as const,
);

/**
 * Names the members of the project file's command sections that no command
 * reads (a typo such as `texra.chat.modle`): the section's row ignores them,
 * so they silently never apply. The file's unknown keys and rejected values
 * are named by the shared open (`openTexraConfigStores`).
 */
function commandSectionWarnings(store: JsonStore): string[] {
  return COMMAND_SECTION_MEMBERS.flatMap(([row, members]) => {
    const key = `${TEXRA_SETTINGS.catalog.namespace}.${row.key}`;
    const value = store.get(key);
    if (
      !Predicate.isObject(value) ||
      Result.isFailure(Schema.decodeUnknownResult(row.schema)(value))
    )
      return [];
    return Object.keys(value)
      .filter((member) => !members.has(member))
      .map(
        (member) =>
          `Ignoring unknown ${store.filePath} key "${key}.${member}".`,
      );
  });
}

/**
 * The CLI config provider's pre-runtime open, already provided with the file
 * services it needs: `buildCliContext` yields it before the command's runtime
 * exists, and `loadConfigAndWarn` is the one
 * place the whole pre-runtime program is run.
 */
export function loadCliStartupConfig(
  cwd: string,
  storageRoot: string,
): Effect.Effect<CliStartupConfig, Error> {
  return Effect.provide(
    Effect.gen(function* () {
      // A run that follows the project's settings (its approval policy,
      // read at each decision) sees what another window or terminal saves
      // while it runs: the stores follow their files.
      const { stores, warnings: degradations } = yield* openTexraConfigStores(
        TEXRA_SETTINGS.catalog,
        storageRoot,
        cwd,
      );
      // The user's MCP server config, which only a run declaring MCP tools
      // otherwise reads: a broken file warns here, not first mid-run.
      const mcpConfig = yield* readMcpConfig(mcpConfigPathOf(storageRoot));
      // A value its catalog row rejects stays in its tier, as in the other
      // hosts: a read of it gets the row's default (and a fail-closed row its
      // own reading), never a looser tier's value. The open names it once at
      // startup.
      return {
        config: new JsonConfigProvider({
          workspace: stores.workspace,
          global: stores.global,
          local: stores.local,
          catalog: TEXRA_SETTINGS.catalog,
        }),
        warnings: [
          ...commandSectionWarnings(stores.workspace),
          ...(mcpConfig?.warnings ?? []),
        ],
        degradations,
      };
    }),
    nodeFileServices,
  );
}

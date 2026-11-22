// Third-party imports
import { Effect, Predicate, Result, Schema } from 'effect';

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
import { openTexraConfigStores } from '@texra/platform/defaults/nodeStores';
import {
  CLI_CHAT_SETTING,
  CLI_MODEL_SETTING,
  CLI_RUN_SETTING,
  TEXRA_SETTINGS,
} from '@texra/shared/settings/texraSettings';

// Local imports - tools

// Local imports - utilities

/** The `texra.*` command sections: `texra.chat` and `texra.run`. */
const COMMAND_SECTIONS = {
  chat: CLI_CHAT_SETTING,
  run: CLI_RUN_SETTING,
} as const;
type CliCommandRole = keyof typeof COMMAND_SECTIONS;

/** The model for one command, after the section/top-level fallthrough. */
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
 * The model for one command: its own `texra.chat` / `texra.run` section over
 * the top-level `texra.model` row, resolved through the setting slots the
 * caller holds — the ones `CliPlatform` handed back, so the value read here
 * is the value `texra config` writes.
 */
export function cliCommandDefaults(
  stores: SettingsStores,
  role: CliCommandRole,
): CliCommandDefaults {
  const sectionRow: SettingRow<CliCommandDefaults | undefined> =
    COMMAND_SECTIONS[role];
  const section = Settings.getConfig(stores.config, sectionRow) ?? {};
  return {
    model:
      section.model ?? Settings.getConfig(stores.config, CLI_MODEL_SETTING),
  };
}

/** The `texra.chat` / `texra.run` rows, each with the members it accepts. */
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

// Third-party imports
import { Effect, Predicate, Result, Schema } from 'effect';

// Local imports - platform
import { modelConfig, MODELS } from '@texra-ai/llm';
import {
  mcpConfigPathOf,
  readMcpConfig,
  type ConfigProvider,
} from '@texra-ai/harness/host';
import { Settings, type SettingsStores } from '@texra-ai/harness/plugins';
import type { SettingRow } from '@texra-ai/harness/schemas';
import {
  JsonConfigProvider,
  nodeFileServices,
  type JsonStore,
} from '@texra-ai/harness/node';

// Local imports - shared
import { openTexraConfigStores } from '@texra/platform/defaults/nodeStores';
import {
  CLI_AGENT_SETTING,
  CLI_CHAT_SETTING,
  CLI_MODEL_SETTING,
  CLI_RUN_SETTING,
  TEXRA_SETTINGS,
} from '@texra/shared/settingsView/texraSettings';

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

/** Agent and model for one command, after the section/top-level fallthrough. */
interface CliCommandDefaults {
  readonly agent?: string;
  readonly model?: string;
}

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
  /** The routine config problems found at open, for the CLI and `texra doctor`. */
  readonly warnings: readonly string[];
  /**
   * The problems saying the project file could not be used at all (malformed
   * JSON, not an object, not writable): actionable degradation, not routine
   * noise, so it is printed even under `--quiet`.
   */
  readonly degradations: readonly string[];
}

/**
 * Agent and model for one command: its own `texra.chat` / `texra.run` section
 * over the top-level `texra.agent` / `texra.model` rows, both resolved through
 * the setting slots the caller holds — the ones `CliPlatform` handed back,
 * so the value read here is the value `texra config` writes.
 */
export function cliCommandDefaults(
  stores: SettingsStores,
  role: CliCommandRole,
): CliCommandDefaults {
  const sectionRow: SettingRow<
    { readonly agent?: string; readonly model?: string } | undefined
  > = COMMAND_SECTIONS[role];
  const section = Settings.getConfig(stores.config, sectionRow) ?? {};
  return {
    agent:
      section.agent ?? Settings.getConfig(stores.config, CLI_AGENT_SETTING),
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
    return yield* Effect.fail(
      new Error('The default chat agent must not be empty.'),
    );
  }
  // The workspace file's own section, not the merged read: the write below
  // lands in the workspace target, so seeding from `workspace over user` would
  // copy a user-level `texra.chat.model` into the project file and pin it
  // above every later user-level edit.
  // A section its row rejects (a string, an array) seeds nothing.
  const stored = stores.config.inspect<unknown>(
    CLI_CHAT_SETTING.key,
  ).workspaceValue;
  const next: { agent?: string; model?: string } = Predicate.isObject(stored)
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

/**
 * The members each command section accepts. `texra run` takes its agent as a
 * required argument, so its section sets only the model.
 */
const COMMAND_SECTION_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['chat', new Set(['agent', 'model'])],
  ['run', new Set(['model'])],
]);

/**
 * Names the config-file entries that cannot apply. An unknown project key (a
 * typo such as `texra.modle` or `texra.chat.modle`) is a setting that silently
 * never applies, and so is a known key whose value its catalog row rejects:
 * a typed read gets its row's default, and a fail-closed reader its own
 * reading (telemetry reads as off). Unknown keys are reported for the
 * project file only: the user file is shared by all three hosts and holds rows
 * the CLI does not honor, so its unrecognized keys are not the CLI's to report.
 * Invalid values are reported for both files, since the CLI reads both.
 */
function configFileWarnings(
  files: readonly {
    readonly store: JsonStore;
    readonly isProjectFile: boolean;
  }[],
): readonly string[] {
  const warnings: string[] = [];
  for (const { store, isProjectFile } of files) {
    const { filePath } = store;
    for (const key of store.keys()) {
      const entry = TEXRA_SETTINGS.catalog.byStoredKey(key);
      if (entry?.slot !== 'config') {
        if (isProjectFile) {
          warnings.push(`Ignoring unknown ${filePath} key "${key}".`);
        }
        continue;
      }
      const value = store.get(key);
      if (Result.isFailure(Schema.decodeUnknownResult(entry.schema)(value))) {
        warnings.push(
          `Ignoring invalid ${filePath} value ${JSON.stringify(value)} for "${key}".`,
        );
        continue;
      }
      const sectionKeys = COMMAND_SECTION_KEYS.get(entry.key);
      if (!isProjectFile || !sectionKeys) continue;
      if (!Predicate.isObject(value)) continue;
      for (const nested of Object.keys(value)) {
        if (sectionKeys.has(nested)) continue;
        warnings.push(`Ignoring unknown ${filePath} key "${key}.${nested}".`);
      }
    }
  }
  return warnings;
}

/**
 * The CLI config provider's pre-runtime open, already provided with the file
 * services it needs: `buildCliContext` yields it before the command's runtime
 * exists, and `contextFromArgs` is the one
 * place the whole pre-runtime program is run.
 */
export function loadCliStartupConfig(
  cwd: string,
  storageRoot: string,
): Effect.Effect<CliStartupConfig, Error> {
  return Effect.provide(
    Effect.gen(function* () {
      const degradations: string[] = [];
      // A run that follows the project's settings (its approval policy,
      // read at each decision) sees what another window or terminal saves
      // while it runs: the stores follow their files.
      const stores = yield* openTexraConfigStores(
        TEXRA_SETTINGS.catalog,
        storageRoot,
        cwd,
        (message) => degradations.push(message),
      );
      // The user's MCP server config, which only a run declaring MCP tools
      // otherwise reads: a broken file warns here, not first mid-run.
      const mcpConfig = yield* readMcpConfig(mcpConfigPathOf(storageRoot));
      // A value its catalog row rejects stays in its tier, as in the other
      // hosts: a read of it gets the row's default (and a fail-closed row its
      // own reading), never a looser tier's value. `warnings` below names it
      // once at startup.
      return {
        config: new JsonConfigProvider({
          workspace: stores.workspace,
          global: stores.global,
          local: stores.local,
          catalog: TEXRA_SETTINGS.catalog,
        }),
        warnings: [
          ...configFileWarnings([
            { store: stores.workspace, isProjectFile: true },
            { store: stores.global, isProjectFile: false },
            { store: stores.local, isProjectFile: false },
          ]),
          ...(mcpConfig?.warnings ?? []),
        ],
        degradations,
      };
    }),
    nodeFileServices,
  );
}

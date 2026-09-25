// Node imports
import path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - platform
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { nodeFileServices, type JsonStore } from '@platform/defaults/jsonStore';
import {
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import type { ConfigProvider } from '@platform/interfaces';

// Local imports - shared
import { canonicalConfigKey } from '@shared/config/configKeys';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  CLI_CONFIG_SLOT_KEYS,
  settingByKey,
} from '@shared/state/stateSettings';

// Local imports - tools
import { MCP_CONFIG_FILE_NAME, mcpConfigWarnings } from '@tools/mcp/mcpConfig';

// Local imports - utilities
import {
  readConfigSettingFrom,
  writeSettingTo,
} from '@utils/config/platformSettings';
import { isObject } from '@utils/core';

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
export const CLI_CHEAP_START_MODEL = 'deepseekproT';

/** The `texra.*` command sections whose members are `agent` and `model`. */
const COMMAND_ROLES = ['chat', 'run'] as const;
export type CliCommandRole = (typeof COMMAND_ROLES)[number];

/** Agent and model for one command, after the section/top-level fallthrough. */
export interface CliCommandDefaults {
  readonly agent?: string;
  readonly model?: string;
  /**
   * Which config tier supplied `model`. The model decision labels its choice
   * with the tier it came from, and the label decides how an unavailable model
   * is reported, so the merged read still names the file behind the value.
   */
  readonly modelScope?: 'workspace-config' | 'user-config';
}

export function isCliSupportedModelId(model: string): boolean {
  const config = MODEL_CONFIGS[model];
  return config != null && config.provider !== ModelProvider.COPILOT;
}

export function knownCliModelIds(): string[] {
  return Object.keys(MODEL_CONFIGS).filter(isCliSupportedModelId);
}

function normalizeCliModelLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');
}

function modelLookupKeys(id: string): string[] {
  const config = MODEL_CONFIGS[id];
  return [id, config?.name, config?.fullName, config?.label].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

export function resolveKnownCliModelId(model: string): string | undefined {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  if (isCliSupportedModelId(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  const ids = knownCliModelIds();
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
   * rows through it and `initCliPlatform` installs this same instance as the
   * workspace roots' config, so a value `texra config` writes is the value the
   * next run reads.
   */
  readonly config: ConfigProvider;
  /** Every config problem found at open, for the CLI and `texra doctor`. */
  readonly warnings: readonly string[];
  /**
   * The subset of `warnings` saying the project file could not be used at all
   * (malformed JSON, not an object, not writable): actionable degradation,
   * not routine noise, so it is printed even under `--quiet`.
   */
  readonly degradations: readonly string[];
}

/**
 * Agent and model for one command: its own `texra.chat` / `texra.run` section
 * over the top-level `texra.agent` / `texra.model` rows, both resolved through
 * the setting slots the caller holds — the ones `initCliPlatform` handed back,
 * so the value read here is the value `texra config` writes.
 */
export function cliCommandDefaults(
  stores: SettingsStores,
  role: CliCommandRole,
): CliCommandDefaults {
  const sectionKey = canonicalConfigKey(role);
  const section =
    readConfigSettingFrom<CliCommandDefaults | undefined>(
      stores.config,
      sectionKey,
    ) ?? {};
  const modelKey = section.model ? sectionKey : canonicalConfigKey('model');
  const model =
    section.model ??
    readConfigSettingFrom<string | undefined>(stores.config, modelKey);
  return {
    agent:
      section.agent ??
      readConfigSettingFrom<string | undefined>(
        stores.config,
        canonicalConfigKey('agent'),
      ),
    model,
    ...(model === undefined
      ? {}
      : {
          modelScope:
            stores.config.inspect(modelKey)?.workspaceValue === undefined
              ? ('user-config' as const)
              : ('workspace-config' as const),
        }),
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
  const sectionKey = canonicalConfigKey('chat');
  // The workspace file's own section, not the merged read: the write below
  // lands in the workspace target, so seeding from `workspace over user` would
  // copy a user-level `texra.chat.model` into the project file and pin it
  // above every later user-level edit.
  const existing =
    stores.config.inspect<CliCommandDefaults>(sectionKey)?.workspaceValue ?? {};
  const next: { agent?: string; model?: string } = { ...existing };
  if (trimmed) next.agent = trimmed;
  else delete next.agent;
  yield* writeSettingTo(
    stores,
    sectionKey,
    Object.keys(next).length > 0 ? next : undefined,
  );
});

/** Canonical `texra.*` keys the CLI recognizes in `.texra/config.json`. */
const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(CLI_CONFIG_SLOT_KEYS);

/** The two members of a `texra.chat` / `texra.run` section. */
const COMMAND_SECTION_KEYS: ReadonlySet<string> = new Set(['agent', 'model']);

const COMMAND_SECTION_CONFIG_KEYS: ReadonlySet<string> = new Set(
  COMMAND_ROLES.map(canonicalConfigKey),
);

/**
 * Names the config-file entries that cannot apply. An unknown project key (a
 * typo such as `texra.modle` or `texra.chat.modle`) is a setting that silently
 * never applies, and so is a known key whose value its catalog row rejects:
 * every read passes over it to the next tier (or the default). Unknown keys are reported for the
 * project file only: the user file is shared by all three hosts and holds rows
 * the CLI does not honor, so its unrecognized keys are not the CLI's to report.
 * Invalid values are reported for both files, since the CLI reads both.
 */
function configFileWarnings(
  files: readonly {
    readonly store: JsonStore;
    readonly filePath: string;
    readonly isProjectFile: boolean;
  }[],
): readonly string[] {
  const warnings: string[] = [];
  for (const { store, filePath, isProjectFile } of files) {
    for (const key of store.keys()) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        if (isProjectFile) {
          warnings.push(`Ignoring unknown ${filePath} key "${key}".`);
        }
        continue;
      }
      const value = store.get<unknown>(key);
      const entry = settingByKey(key);
      if (entry && !entry.schema.safeParse(value).success) {
        warnings.push(
          `Ignoring invalid ${filePath} value ${JSON.stringify(value)} for "${key}".`,
        );
        continue;
      }
      if (!isProjectFile || !COMMAND_SECTION_CONFIG_KEYS.has(key)) continue;
      if (!isObject(value)) continue;
      for (const nested of Object.keys(value)) {
        if (COMMAND_SECTION_KEYS.has(nested)) continue;
        warnings.push(`Ignoring unknown ${filePath} key "${key}.${nested}".`);
      }
    }
  }
  return warnings;
}

/**
 * The CLI config provider's pre-runtime open, already provided with the file
 * services it needs: `buildCliContext` yields it before `initCliPlatform` (and
 * with it `installCliProcessRuntime`) exists, and `contextFromArgs` is the one
 * place the whole pre-runtime program is run.
 */
export function loadCliStartupConfig(
  cwd: string,
  storageRoot: string,
): Effect.Effect<CliStartupConfig, Error> {
  return Effect.provide(
    Effect.gen(function* () {
      const degradations: string[] = [];
      const stores = yield* openTexraConfigStores(storageRoot, cwd, (message) =>
        degradations.push(message),
      );
      // The user's MCP server config, which only a run declaring MCP tools
      // otherwise reads: a broken file warns here, not first mid-run.
      const mcpWarnings = yield* mcpConfigWarnings(
        yield* FileSystem.FileSystem,
        path.join(storageRoot, MCP_CONFIG_FILE_NAME),
      );
      return {
        config: new JsonConfigProvider(stores),
        warnings: [
          ...degradations,
          ...configFileWarnings([
            {
              store: stores.workspace,
              filePath: workspaceTexraConfigPath(cwd),
              isProjectFile: true,
            },
            {
              store: stores.global,
              filePath: path.join(
                resolveGlobalStoragePath(storageRoot),
                TEXRA_CONFIG_FILE_NAME,
              ),
              isProjectFile: false,
            },
          ]),
          ...mcpWarnings,
        ],
        degradations,
      };
    }),
    nodeFileServices,
  );
}

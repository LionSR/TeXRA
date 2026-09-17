// Third-party imports
import { Effect } from 'effect';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - platform
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { nodeFileServices, type JsonStore } from '@platform/defaults/jsonStore';
import {
  DEFAULT_NODE_STORAGE_ROOT,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import type { ConfigProvider } from '@platform/interfaces';

// Local imports - shared
import { canonicalConfigKey } from '@shared/config/configKeys';
import { readConfigSetting } from '@shared/config/settingsAccess';
import { CLI_CONFIG_SLOT_KEYS, settingByKey } from '@shared/schemas';

// Local imports - utilities
import {
  platformSettingsStores,
  readSettingFrom,
  writePlatformSetting,
} from '@utils/config/platformSettings';
import { isObject } from '@utils/core';

// Local file imports
import { writeTextStderr } from './logSinks';

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
   * next run reads — including when the project file cannot be written and
   * both ends fall back to the internal workspace store.
   */
  readonly config: ConfigProvider;
  readonly warnings: readonly string[];
}

/** A config-slot catalog row, read and validated through its own schema. */
export function readCliConfigSetting<T>(
  config: ConfigProvider,
  key: string,
): T {
  const entry = settingByKey(key);
  if (!entry) throw new Error(`No setting catalog entry for key: ${key}`);
  return readConfigSetting(entry, config) as T;
}

/**
 * Agent and model for one command: its own `texra.chat` / `texra.run` section
 * over the top-level `texra.agent` / `texra.model` rows, both resolved through
 * the process's config provider (workspace file over user file).
 *
 * Runs after `initCliPlatform`, which installs the roots holding that provider.
 */
export function cliCommandDefaults(role: CliCommandRole): CliCommandDefaults {
  const stores = platformSettingsStores();
  const sectionKey = canonicalConfigKey(role);
  const section =
    readSettingFrom<CliCommandDefaults | undefined>(stores, sectionKey) ?? {};
  const modelKey = section.model ? sectionKey : canonicalConfigKey('model');
  const model =
    section.model ?? readSettingFrom<string | undefined>(stores, modelKey);
  return {
    agent:
      section.agent ??
      readSettingFrom<string | undefined>(stores, canonicalConfigKey('agent')),
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
)(function* (agent: string | undefined) {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    return yield* Effect.fail(
      new Error('The default chat agent must not be empty.'),
    );
  }
  const sectionKey = canonicalConfigKey('chat');
  const existing =
    readSettingFrom<CliCommandDefaults | undefined>(
      platformSettingsStores(),
      sectionKey,
    ) ?? {};
  const next: { agent?: string; model?: string } = { ...existing };
  if (trimmed) next.agent = trimmed;
  else delete next.agent;
  yield* writePlatformSetting(
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
 * Names the project-file keys nothing reads — a typo (`texra.modle`,
 * `texra.chat.modle`) is otherwise a setting that silently never applies. Only
 * the workspace file is walked: the user file is shared by all three hosts and
 * holds rows the CLI does not honor, so its unrecognized keys are not the
 * CLI's to report.
 */
function unknownKeyWarnings(
  store: JsonStore,
  filePath: string,
): readonly string[] {
  const warnings: string[] = [];
  for (const key of store.keys()) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      warnings.push(`Ignoring unknown ${filePath} key "${key}".`);
      continue;
    }
    if (!COMMAND_SECTION_CONFIG_KEYS.has(key)) continue;
    const section = store.get<unknown>(key);
    if (!isObject(section)) continue;
    for (const nested of Object.keys(section)) {
      if (COMMAND_SECTION_KEYS.has(nested)) continue;
      warnings.push(`Ignoring unknown ${filePath} key "${key}.${nested}".`);
    }
  }
  return warnings;
}

/**
 * Malformed or unwritable project config is actionable degradation, not
 * routine progress noise, so it reaches stderr immediately rather than joining
 * the `--quiet`-gated warnings the caller prints.
 */
function showPersistentConfigWarning(message: string): void {
  writeTextStderr(`[warn] [cli.config] ${message}`);
}

/**
 * The one bare run edge of the CLI's config, and the one caller that needs it:
 * `buildCliContext` opens the config stores BEFORE `initCliPlatform` (and with
 * it `installCliProcessRuntime`), so there is no process runtime to borrow yet;
 * the program needs the filesystem and nothing else. Pinned in
 * `BARE_EFFECT_RUN_SITES`.
 *
 * The storage paths come from the pure calculators rather than
 * `WorkspaceStorageProvider`'s getters: opening a config store must not create
 * a directory under a storage root a command (`clone`) may only be able to
 * read.
 */
export function loadCliStartupConfig(
  cwd: string,
  storageRoot: string = DEFAULT_NODE_STORAGE_ROOT,
): Promise<CliStartupConfig> {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const stores = yield* openTexraConfigStores(
          {
            getStoragePath: () => resolveWorkspaceStoragePath(storageRoot, cwd),
            getGlobalStoragePath: () => resolveGlobalStoragePath(storageRoot),
          },
          cwd,
          showPersistentConfigWarning,
        );
        return {
          config: new JsonConfigProvider(stores),
          warnings: unknownKeyWarnings(
            stores.workspace,
            workspaceTexraConfigPath(cwd),
          ),
        };
      }),
      nodeFileServices,
    ),
  );
}

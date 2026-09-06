import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';
import { z } from 'zod';

import { Effect, Result } from 'effect';
import { isFileNotFoundError } from '@common/errors';
import { safeParseJson } from '@common/parsing/safeParseJson';
import { JsonStore } from '@platform/defaults/jsonStore';
import {
  DEFAULT_NODE_STORAGE_ROOT,
  TEXRA_CONFIG_FILE_NAME,
  workspaceTexraConfigPath,
} from '@platform/defaults/nodeStorage';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import {
  TexraApprovalPolicySchema,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { canonicalConfigKey } from '@shared/config/configKeys';
import { isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  CLI_OUTPUT_FORMATS,
  CLI_SETTING_PATHS,
  type CliOutputFormat,
} from '../schemas/cliSettings';
import { KNOWN_TEXRA_KEYS } from '../schemas/knownKeys';

export const CLI_BUILTIN_DEFAULT_MODEL = 'deepseekproT';

interface CliCommandConfig {
  readonly agent?: string;
  readonly model?: string;
}

export interface CliConfigValues extends CliCommandConfig {
  readonly outputFormat?: CliOutputFormat;
  readonly approvalPolicy?: TexraApprovalPolicy;
  readonly chat?: CliCommandConfig;
  readonly run?: CliCommandConfig;
}

interface LoadedCliConfig {
  readonly path?: string;
  readonly values: CliConfigValues;
  readonly warnings: readonly string[];
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

const NonEmptyStringSchema = z.string().trim().min(1);
const ModelSchema = NonEmptyStringSchema.refine(isCliSupportedModelId, {
  message: 'unknown model',
});
const OutputFormatSchema = z.enum(CLI_OUTPUT_FORMATS);

type CliScalarFields = Required<Omit<CliConfigValues, 'chat' | 'run'>>;
type CliRequiredCommandConfig = Required<CliCommandConfig>;

/** One `[key, schema]` pair whose schema output matches `T`'s type for that
 *  same key — so a transposed pair (e.g. `model`'s key with an output-format
 *  schema) is a compile error at the declaration below, not just a runtime
 *  mismatch caught by `pickFields`. */
type FieldSchemaEntry<T> = {
  [K in keyof T]-?: readonly [K, z.ZodType<T[K]>];
}[keyof T];

/** Single source of truth for the top-level scalar fields: `pickFields` walks
 *  this one list to produce both the picked value and its validation warning
 *  in the same pass, instead of each being a separately re-declared walk. */
const TOP_LEVEL_FIELD_SCHEMAS: ReadonlyArray<
  FieldSchemaEntry<CliScalarFields>
> = [
  ['agent', NonEmptyStringSchema],
  ['model', ModelSchema],
  ['outputFormat', OutputFormatSchema],
  // Same normalization the catalog row (`stateSettings.ts`) applies for the
  // other hosts, so a hand-edited " Yolo" reads the same way in all three.
  [
    'approvalPolicy',
    z.preprocess(
      (raw) => (typeof raw === 'string' ? raw.trim().toLowerCase() : raw),
      TexraApprovalPolicySchema,
    ),
  ],
];

/** Same role as {@link TOP_LEVEL_FIELD_SCHEMAS}, for the `chat`/`run` command
 *  sections — shared by `pickCommandSection`. */
const COMMAND_FIELD_SCHEMAS: ReadonlyArray<
  FieldSchemaEntry<CliRequiredCommandConfig>
> = [
  ['agent', NonEmptyStringSchema],
  ['model', ModelSchema],
];
const COMMAND_SECTIONS = ['chat', 'run'] as const;

const TOP_LEVEL_KEYS = new Set<string>(
  CLI_SETTING_PATHS.map(canonicalConfigKey),
);
const COMMAND_KEYS = new Set(COMMAND_FIELD_SCHEMAS.map(([key]) => key));

function isKnownConfigKey(key: string): boolean {
  return TOP_LEVEL_KEYS.has(key) || KNOWN_TEXRA_KEYS.has(key);
}

function warnUnknownKeys(
  warnings: string[],
  filePath: string,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix = '',
): void {
  for (const key of Object.keys(record)) {
    if (
      !allowed.has(key) &&
      !isKnownConfigKey(prefix ? `${prefix}${key}` : key)
    ) {
      warnings.push(`Ignoring unknown ${filePath} key "${prefix}${key}".`);
    }
  }
}

/** Picks every `[key, schema]` pair present and valid in `record`, reading
 *  each field under `keyFor(key)` (the raw key for command sections, the
 *  canonical `texra.*` key at the top level), and pushing one warning per
 *  invalid field into `warnings` in the same pass — a value and its warning
 *  can no longer drift apart by only calling one of two walks. `fields`'
 *  declaration site is checked against `T` (see {@link FieldSchemaEntry});
 *  only this loop body — not the caller — needs to assert the per-iteration
 *  correlation back to a specific `K`. */
function pickFields<T extends object>(
  record: Record<string, unknown>,
  fields: ReadonlyArray<FieldSchemaEntry<T>>,
  keyFor: (key: keyof T) => string,
  warnings: string[],
  filePath: string,
  prefix = '',
): Partial<T> {
  const picked: Partial<T> = {};
  for (const [key, schema] of fields) {
    const storedKey = keyFor(key);
    if (!Object.hasOwn(record, storedKey)) continue;
    const parsed = schema.safeParse(record[storedKey]);
    if (parsed.success) {
      picked[key] = parsed.data as T[typeof key];
    } else {
      warnings.push(
        `Ignoring invalid ${filePath} key "${prefix}${storedKey}".`,
      );
    }
  }
  return picked;
}

interface PickConfigOptions {
  /** Gates only the *top-level* unknown-key check — the shared user config
   *  holds rows the other hosts honor and the CLI doesn't (see
   *  {@link parseCliConfigValues}). The `chat`/`run` sections underneath a
   *  known top-level key are CLI-exclusive structure in every host (nothing
   *  else reads or writes `texra.chat.*`/`texra.run.*`), so an unknown key
   *  nested inside one of them always warns regardless of this flag — a
   *  typo like `texra.chat.modle` is a bug report worth surfacing even when
   *  the file's other top-level rows are being read leniently. */
  readonly reportUnknownKeys: boolean;
  /** Restricts which command sections get read (and thus warned about) —
   *  `undefined` means all of {@link COMMAND_SECTIONS}. A caller that only
   *  resolves `chat` values has no use warning about a `run.*` typo, and
   *  every extra field read is a field a caller invoked on every loop
   *  iteration (e.g. `resolveChatDefaults` from `orchestrate`'s launcher
   *  loop) can print the same warning again on the next pass. */
  readonly sections?: ReadonlySet<(typeof COMMAND_SECTIONS)[number]>;
  /** Restricts which top-level scalar fields get read — same rationale as
   *  `sections`, one level up. */
  readonly topLevelFields?: ReadonlySet<keyof CliScalarFields>;
}

function pickCommandSection(
  record: Record<string, unknown>,
  section: (typeof COMMAND_SECTIONS)[number],
  warnings: string[],
  filePath: string,
): CliCommandConfig | undefined {
  const sectionKey = canonicalConfigKey(section);
  if (!Object.hasOwn(record, sectionKey)) return undefined;
  const sectionValue = record[sectionKey];
  if (!isObject(sectionValue)) {
    warnings.push(`Ignoring invalid ${filePath} key "${sectionKey}".`);
    return undefined;
  }
  const prefix = `${sectionKey}.`;
  // Always checked: chat.*/run.* are CLI-exclusive structure, so a typo'd
  // key here is never a false positive the way a shared top-level row is.
  warnUnknownKeys(warnings, filePath, sectionValue, COMMAND_KEYS, prefix);
  return pickFields<CliRequiredCommandConfig>(
    sectionValue,
    COMMAND_FIELD_SCHEMAS,
    (key) => key,
    warnings,
    filePath,
    prefix,
  );
}

function pickConfigValues(
  record: Record<string, unknown>,
  warnings: string[],
  filePath: string,
  options: PickConfigOptions,
): CliConfigValues {
  if (options.reportUnknownKeys) {
    warnUnknownKeys(warnings, filePath, record, TOP_LEVEL_KEYS);
  }
  const wantsSection = (section: (typeof COMMAND_SECTIONS)[number]): boolean =>
    options.sections?.has(section) ?? true;
  const chat = wantsSection('chat')
    ? pickCommandSection(record, 'chat', warnings, filePath)
    : undefined;
  const run = wantsSection('run')
    ? pickCommandSection(record, 'run', warnings, filePath)
    : undefined;
  const topLevelFields = options.topLevelFields
    ? TOP_LEVEL_FIELD_SCHEMAS.filter(([key]) =>
        options.topLevelFields?.has(key),
      )
    : TOP_LEVEL_FIELD_SCHEMAS;
  return {
    ...pickFields<CliScalarFields>(
      record,
      topLevelFields,
      canonicalConfigKey,
      warnings,
      filePath,
    ),
    ...(chat ? { chat } : {}),
    ...(run ? { run } : {}),
  };
}

/** Parses one config file's values and warnings in a single walk — the
 *  single source of truth for both is {@link TOP_LEVEL_FIELD_SCHEMAS} /
 *  {@link COMMAND_FIELD_SCHEMAS}, read once per field. `filePath` is only
 *  used to word warning messages; pass the caller's best label for `value`'s
 *  origin (a real path, or a description) when there isn't one on disk.
 *  `reportUnknownKeys` (default `true`) should be `false` for the shared
 *  user-level config file: it holds rows the other hosts honor and the CLI
 *  doesn't, so flagging them as "unknown" would be a false positive — the
 *  same reasoning {@link loadUserApprovalPolicy} documents for that file.
 *  `topLevelFields`/`sections` scope which fields get read at all — use
 *  them when a caller only consumes a subset (see {@link PickConfigOptions}). */
export function parseCliConfigValues(
  value: unknown,
  filePath: string,
  options: Partial<PickConfigOptions> = {},
): { readonly values: CliConfigValues; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const values = isObject(value)
    ? pickConfigValues(value, warnings, filePath, {
        ...options,
        reportUnknownKeys: options.reportUnknownKeys ?? true,
      })
    : {};
  return { values, warnings };
}

/**
 * Read and JSON-parse a TeXRA config file, distinguishing "file does not
 * exist" (silently defaulted by both callers) from a read/parse/shape
 * problem (surfaced as a single warning) from a successfully parsed object.
 * Shared by {@link loadWorkspaceCliConfig} and {@link loadUserApprovalPolicy},
 * which otherwise duplicate this read-catch-parse-validate sequence.
 */
type JsonConfigFileResult =
  | { readonly status: 'missing' }
  | { readonly status: 'warning'; readonly warning: string }
  | { readonly status: 'ok'; readonly parsed: Record<string, unknown> };

async function readJsonConfigFile(
  filePath: string,
): Promise<JsonConfigFileResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    return {
      status: 'warning',
      warning: `Could not read ${filePath}: ${toErrorMessage(error)}`,
    };
  }

  const parseResult = safeParseJson(raw);
  if (Result.isFailure(parseResult)) {
    return {
      status: 'warning',
      warning: `Could not parse ${filePath}: ${toErrorMessage(parseResult.failure)}`,
    };
  }
  const parsed = parseResult.success;
  if (!isObject(parsed)) {
    return {
      status: 'warning',
      warning: `Ignoring ${filePath}; expected a JSON object.`,
    };
  }
  return { status: 'ok', parsed };
}

export async function loadWorkspaceCliConfig(
  cwd: string,
): Promise<LoadedCliConfig> {
  const filePath = workspaceTexraConfigPath(cwd);
  const result = await readJsonConfigFile(filePath);
  if (result.status === 'missing') return { values: {}, warnings: [] };
  if (result.status === 'warning') {
    return { path: filePath, values: {}, warnings: [result.warning] };
  }
  const { values, warnings } = parseCliConfigValues(result.parsed, filePath);
  return { path: filePath, values, warnings };
}

/**
 * The user-level layer of `texra.approvalPolicy`
 * (`~/.texra/global-storage/config.json`).
 *
 * The extension and desktop hosts resolve this row through `workspaceRoots().config`,
 * which layers the project `.texra/config.json` over the user file. The CLI
 * resolves its approval policy in `buildCliContext`, before `initCliPlatform`
 * creates that provider, so it reads the user layer here rather than standing
 * up a second config provider — otherwise a policy set once in `/config` (or
 * by the extension) is honored by two hosts and silently ignored by the third.
 *
 * Only this one key is read. The other CLI config fields are either
 * workspace-scoped or already resolve their own user layer (`chatDefaults`),
 * and unknown keys are not reported: the file is shared by all three hosts and
 * holds rows the CLI does not honor.
 */
export async function loadUserApprovalPolicy(
  storageRoot: string = DEFAULT_NODE_STORAGE_ROOT,
): Promise<{
  readonly value?: TexraApprovalPolicy;
  readonly warnings: readonly string[];
}> {
  const filePath = path.join(
    resolveGlobalStoragePath(storageRoot),
    TEXRA_CONFIG_FILE_NAME,
  );
  const result = await readJsonConfigFile(filePath);
  if (result.status === 'missing') return { warnings: [] };
  if (result.status === 'warning') return { warnings: [result.warning] };

  const { values, warnings } = parseCliConfigValues(result.parsed, filePath, {
    reportUnknownKeys: false,
    topLevelFields: new Set(['approvalPolicy']),
    sections: new Set(),
  });
  return { value: values.approvalPolicy, warnings };
}

/**
 * Update the workspace chat-agent default without replacing unrelated config.
 * Nested command defaults remain a JSON object under the canonical
 * `texra.chat` key.
 */
export const setWorkspaceCliChatAgent = Effect.fn(
  'cliConfig.setWorkspaceCliChatAgent',
)(function* (cwd: string, agent: string | undefined) {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    return yield* Effect.fail(
      new Error('The default chat agent must not be empty.'),
    );
  }
  const store = yield* JsonStore.open(workspaceTexraConfigPath(cwd));
  const snapshot = store.snapshot();
  const sectionKey = canonicalConfigKey('chat');
  const existing = isObject(snapshot[sectionKey]) ? snapshot[sectionKey] : {};
  const next = { ...existing };
  if (trimmed) next.agent = trimmed;
  else delete next.agent;
  yield* store.set(sectionKey, Object.keys(next).length > 0 ? next : undefined);
});

export function resolveConfiguredAgent(
  config: CliConfigValues | undefined,
  command: 'chat' | 'run',
): string | undefined {
  return config?.[command]?.agent ?? config?.agent;
}

export function commandConfigModel(
  config: CliConfigValues | undefined,
  command: 'chat' | 'run',
): string | undefined {
  return config?.[command]?.model ?? config?.model;
}

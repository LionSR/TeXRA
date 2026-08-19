import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';
import { z } from 'zod';

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
  parseTexraApprovalPolicy,
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
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

export interface LoadedCliConfig {
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

const TOP_LEVEL_FIELD_SCHEMAS: ReadonlyArray<[string, z.ZodType]> = [
  ['agent', NonEmptyStringSchema],
  ['model', ModelSchema],
  ['outputFormat', OutputFormatSchema],
  ['approvalPolicy', TexraApprovalPolicySchema],
];

const COMMAND_FIELD_SCHEMAS: ReadonlyArray<[string, z.ZodType]> = [
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

function warnInvalidField(
  warnings: string[],
  filePath: string,
  record: Record<string, unknown>,
  key: string,
  schema: z.ZodType,
  prefix = '',
): void {
  if (!Object.hasOwn(record, key)) return;
  const parsed = schema.safeParse(record[key]);
  if (!parsed.success) {
    warnings.push(`Ignoring invalid ${filePath} key "${prefix}${key}".`);
  }
}

function collectValidationWarnings(
  filePath: string,
  record: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  warnUnknownKeys(warnings, filePath, record, TOP_LEVEL_KEYS);

  for (const [key, schema] of TOP_LEVEL_FIELD_SCHEMAS) {
    const storedKey = canonicalConfigKey(key);
    warnInvalidField(warnings, filePath, record, storedKey, schema);
  }

  for (const section of COMMAND_SECTIONS) {
    const sectionKey = canonicalConfigKey(section);
    if (!Object.hasOwn(record, sectionKey)) continue;
    const sectionValue = record[sectionKey];
    if (!isObject(sectionValue)) {
      warnings.push(`Ignoring invalid ${filePath} key "${sectionKey}".`);
      continue;
    }
    const prefix = `${sectionKey}.`;
    warnUnknownKeys(warnings, filePath, sectionValue, COMMAND_KEYS, prefix);
    for (const [key, schema] of COMMAND_FIELD_SCHEMAS) {
      warnInvalidField(warnings, filePath, sectionValue, key, schema, prefix);
    }
  }
  return warnings;
}

function parseOptional<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  return schema.optional().catch(undefined).parse(value);
}

function pickCommandConfig(record: Record<string, unknown>): CliCommandConfig {
  return {
    agent: parseOptional(NonEmptyStringSchema, record.agent),
    model: parseOptional(ModelSchema, record.model),
  };
}

function pickValue<T>(
  record: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): T | undefined {
  return parseOptional(schema, record[canonicalConfigKey(key)]);
}

function pickRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[canonicalConfigKey(key)];
  return isObject(value) ? value : undefined;
}

function pickConfigValues(record: Record<string, unknown>): CliConfigValues {
  const chat = pickRecord(record, 'chat');
  const run = pickRecord(record, 'run');
  return {
    agent: pickValue(record, 'agent', NonEmptyStringSchema),
    model: pickValue(record, 'model', ModelSchema),
    outputFormat: pickValue(record, 'outputFormat', OutputFormatSchema),
    approvalPolicy: pickValue(
      record,
      'approvalPolicy',
      TexraApprovalPolicySchema,
    ),
    chat: chat ? pickCommandConfig(chat) : undefined,
    run: run ? pickCommandConfig(run) : undefined,
  };
}

export function parseCliConfigValues(value: unknown): CliConfigValues {
  return isObject(value) ? pickConfigValues(value) : {};
}

export async function loadWorkspaceCliConfig(
  cwd: string,
): Promise<LoadedCliConfig> {
  const filePath = workspaceTexraConfigPath(cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return { values: {}, warnings: [] };
    }
    return {
      path: filePath,
      values: {},
      warnings: [`Could not read ${filePath}: ${toErrorMessage(error)}`],
    };
  }

  const parseResult = safeParseJson(raw);
  if (parseResult.isErr()) {
    return {
      path: filePath,
      values: {},
      warnings: [
        `Could not parse ${filePath}: ${toErrorMessage(parseResult.error)}`,
      ],
    };
  }
  const parsed = parseResult.value;

  if (!isObject(parsed)) {
    return {
      path: filePath,
      values: {},
      warnings: [`Ignoring ${filePath}; expected a JSON object.`],
    };
  }

  return {
    path: filePath,
    values: parseCliConfigValues(parsed),
    warnings: collectValidationWarnings(filePath, parsed),
  };
}

/**
 * The user-level layer of `texra.approvalPolicy`
 * (`~/.texra/global-storage/config.json`).
 *
 * The extension and desktop hosts resolve this row through `platform().config`,
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
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) return { warnings: [] };
    return {
      warnings: [`Could not read ${filePath}: ${toErrorMessage(error)}`],
    };
  }

  const parseResult = safeParseJson(raw);
  if (parseResult.isErr()) {
    return {
      warnings: [
        `Could not parse ${filePath}: ${toErrorMessage(parseResult.error)}`,
      ],
    };
  }
  const parsed = parseResult.value;
  if (!isObject(parsed)) {
    return { warnings: [`Ignoring ${filePath}; expected a JSON object.`] };
  }

  const stored = parsed[TEXRA_APPROVAL_POLICY_CONFIG_KEY];
  if (stored === undefined) return { warnings: [] };
  // Same normalization the catalog row applies for every other host, so a
  // hand-edited " Yolo" reads the same way in all three.
  const policy =
    typeof stored === 'string' ? parseTexraApprovalPolicy(stored) : undefined;
  if (!policy) {
    return {
      warnings: [
        `Ignoring invalid ${filePath} key "${TEXRA_APPROVAL_POLICY_CONFIG_KEY}".`,
      ],
    };
  }
  return { value: policy, warnings: [] };
}

/**
 * Update the workspace chat-agent default without replacing unrelated config.
 * Nested command defaults remain a JSON object under the canonical
 * `texra.chat` key.
 */
export async function setWorkspaceCliChatAgent(
  cwd: string,
  agent: string | undefined,
): Promise<void> {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    throw new Error('The default chat agent must not be empty.');
  }
  const store = await JsonStore.open(workspaceTexraConfigPath(cwd));
  const snapshot = store.snapshot();
  const sectionKey = canonicalConfigKey('chat');
  const existing = isObject(snapshot[sectionKey]) ? snapshot[sectionKey] : {};
  const next = { ...existing };
  if (trimmed) next.agent = trimmed;
  else delete next.agent;
  await store.set(sectionKey, Object.keys(next).length > 0 ? next : undefined);
}

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

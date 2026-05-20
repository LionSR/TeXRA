import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { MODEL_CONFIGS } from 'llm-zoo';
import { z } from 'zod';

import {
  CLI_APPROVAL_POLICIES,
  CLI_OUTPUT_FORMATS,
  type CliApprovalPolicy,
  type CliOutputFormat,
} from '../schemas/cliSettings';
import { KNOWN_TEXRA_KEYS } from '../schemas/knownKeys';

// Re-export so existing call sites (`from './cliConfig'`) keep working — the
// canonical home is `@utils/config/settingsSchema`.
export { CLI_OUTPUT_FORMATS, type CliOutputFormat };

export const CLI_CONFIG_DIR = '.texra';
export const CLI_CONFIG_FILE = 'config.json';
export const CLI_BUILTIN_DEFAULT_MODEL = 'deepseekT';

export interface CliCommandConfig {
  readonly agent?: string;
  readonly model?: string;
}

export interface CliConfigValues extends CliCommandConfig {
  readonly outputFormat?: CliOutputFormat;
  readonly approvalPolicy?: CliApprovalPolicy;
  readonly chat?: CliCommandConfig;
  readonly run?: CliCommandConfig;
}

export interface LoadedCliConfig {
  readonly path?: string;
  readonly values: CliConfigValues;
  readonly warnings: readonly string[];
}

const TOP_LEVEL_KEYS = new Set([
  'agent',
  'model',
  'outputFormat',
  'approvalPolicy',
  'chat',
  'run',
]);

const COMMAND_KEYS = new Set(['agent', 'model']);

const NonEmptyStringSchema = z.string().trim().min(1);
const ModelSchema = NonEmptyStringSchema.refine(
  (model) => MODEL_CONFIGS[model],
  {
    message: 'unknown model',
  },
);
const OutputFormatSchema = z.enum(CLI_OUTPUT_FORMATS);
const ApprovalPolicySchema = z.enum(CLI_APPROVAL_POLICIES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownConfigKey(key: string): boolean {
  return (
    TOP_LEVEL_KEYS.has(key) ||
    KNOWN_TEXRA_KEYS.has(key) ||
    KNOWN_TEXRA_KEYS.has(`texra.${key}`)
  );
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

// Top-level fields validated under both bare (legacy) and `texra.*` forms.
const TOP_LEVEL_FIELD_SCHEMAS: ReadonlyArray<[string, z.ZodType]> = [
  ['agent', NonEmptyStringSchema],
  ['model', ModelSchema],
  ['outputFormat', OutputFormatSchema],
  ['approvalPolicy', ApprovalPolicySchema],
];

const COMMAND_FIELD_SCHEMAS: ReadonlyArray<[string, z.ZodType]> = [
  ['agent', NonEmptyStringSchema],
  ['model', ModelSchema],
];

function collectValidationWarnings(
  filePath: string,
  record: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  warnUnknownKeys(warnings, filePath, record, TOP_LEVEL_KEYS);

  // Validate top-level fields in both bare (legacy) and `texra.*` forms.
  for (const [key, schema] of TOP_LEVEL_FIELD_SCHEMAS) {
    warnInvalidField(warnings, filePath, record, key, schema);
    warnInvalidField(warnings, filePath, record, `texra.${key}`, schema);
  }

  for (const section of ['chat', 'run', 'texra.chat', 'texra.run'] as const) {
    if (!Object.hasOwn(record, section)) continue;
    const sectionValue = record[section];
    if (!isPlainRecord(sectionValue)) {
      warnings.push(`Ignoring invalid ${filePath} key "${section}".`);
      continue;
    }
    const prefix = `${section}.`;
    warnUnknownKeys(warnings, filePath, sectionValue, COMMAND_KEYS, prefix);
    for (const [key, schema] of COMMAND_FIELD_SCHEMAS) {
      warnInvalidField(warnings, filePath, sectionValue, key, schema, prefix);
    }
  }
  return warnings;
}

function parseOptional<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function pickCommandConfig(record: Record<string, unknown>): CliCommandConfig {
  return {
    agent: parseOptional(NonEmptyStringSchema, record.agent),
    model: parseOptional(ModelSchema, record.model),
  };
}

/** Look up a value by both bare and `texra.*` prefixed key — prefixed takes precedence. */
function pickValue<T>(
  record: Record<string, unknown>,
  bareKey: string,
  schema: z.ZodType<T>,
): T | undefined {
  for (const key of [`texra.${bareKey}`, bareKey]) {
    if (Object.hasOwn(record, key)) return parseOptional(schema, record[key]);
  }
  return undefined;
}

function pickRecord(
  record: Record<string, unknown>,
  bareKey: string,
): Record<string, unknown> | undefined {
  for (const key of [`texra.${bareKey}`, bareKey]) {
    const value = record[key];
    if (isPlainRecord(value)) return value;
  }
  return undefined;
}

function pickConfigValues(record: Record<string, unknown>): CliConfigValues {
  const chat = pickRecord(record, 'chat');
  const run = pickRecord(record, 'run');
  return {
    agent: pickValue(record, 'agent', NonEmptyStringSchema),
    model: pickValue(record, 'model', ModelSchema),
    outputFormat: pickValue(record, 'outputFormat', OutputFormatSchema),
    approvalPolicy: pickValue(record, 'approvalPolicy', ApprovalPolicySchema),
    chat: chat ? pickCommandConfig(chat) : undefined,
    run: run ? pickCommandConfig(run) : undefined,
  };
}

export function workspaceCliConfigPath(cwd: string): string {
  return path.join(cwd, CLI_CONFIG_DIR, CLI_CONFIG_FILE);
}

export function isKnownCliModel(model: string): boolean {
  return MODEL_CONFIGS[model] != null;
}

export async function loadWorkspaceCliConfig(
  cwd: string,
): Promise<LoadedCliConfig> {
  const filePath = workspaceCliConfigPath(cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return { values: {}, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: filePath,
      values: {},
      warnings: [`Could not parse ${filePath}: ${message}`],
    };
  }

  if (!isPlainRecord(parsed)) {
    return {
      path: filePath,
      values: {},
      warnings: [`Ignoring ${filePath}; expected a JSON object.`],
    };
  }

  return {
    path: filePath,
    values: pickConfigValues(parsed),
    warnings: collectValidationWarnings(filePath, parsed),
  };
}

export function resolveConfiguredAgent(
  config: CliConfigValues | undefined,
  command: 'chat' | 'run',
): string | undefined {
  return config?.[command]?.agent ?? config?.agent;
}

export function resolveConfiguredModel(
  config: CliConfigValues | undefined,
  command: 'chat' | 'run',
): string | undefined {
  return config?.[command]?.model ?? config?.model;
}

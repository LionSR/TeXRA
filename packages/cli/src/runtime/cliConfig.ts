import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { MODEL_CONFIGS } from 'llm-zoo';
import { z } from 'zod';

import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from './approvalPolicy';

export const CLI_CONFIG_DIR = '.texra';
export const CLI_CONFIG_FILE = 'config.json';
export const CLI_BUILTIN_DEFAULT_MODEL = 'deepseekT';

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

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

function warnUnknownKeys(
  warnings: string[],
  filePath: string,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix = '',
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
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
  warnInvalidField(warnings, filePath, record, 'agent', NonEmptyStringSchema);
  warnInvalidField(warnings, filePath, record, 'model', ModelSchema);
  warnInvalidField(
    warnings,
    filePath,
    record,
    'outputFormat',
    OutputFormatSchema,
  );
  warnInvalidField(
    warnings,
    filePath,
    record,
    'approvalPolicy',
    ApprovalPolicySchema,
  );

  for (const section of ['chat', 'run'] as const) {
    if (!Object.hasOwn(record, section)) continue;
    const sectionValue = record[section];
    if (!isPlainRecord(sectionValue)) {
      warnings.push(`Ignoring invalid ${filePath} key "${section}".`);
      continue;
    }
    warnUnknownKeys(
      warnings,
      filePath,
      sectionValue,
      COMMAND_KEYS,
      `${section}.`,
    );
    warnInvalidField(
      warnings,
      filePath,
      sectionValue,
      'agent',
      NonEmptyStringSchema,
      `${section}.`,
    );
    warnInvalidField(
      warnings,
      filePath,
      sectionValue,
      'model',
      ModelSchema,
      `${section}.`,
    );
  }
  return warnings;
}

function parseOptional<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function pickCommandConfig(record: Record<string, unknown>): CliCommandConfig {
  return {
    agent: Object.hasOwn(record, 'agent')
      ? parseOptional(NonEmptyStringSchema, record.agent)
      : undefined,
    model: Object.hasOwn(record, 'model')
      ? parseOptional(ModelSchema, record.model)
      : undefined,
  };
}

function pickConfigValues(record: Record<string, unknown>): CliConfigValues {
  return {
    agent: Object.hasOwn(record, 'agent')
      ? parseOptional(NonEmptyStringSchema, record.agent)
      : undefined,
    model: Object.hasOwn(record, 'model')
      ? parseOptional(ModelSchema, record.model)
      : undefined,
    outputFormat: Object.hasOwn(record, 'outputFormat')
      ? parseOptional(OutputFormatSchema, record.outputFormat)
      : undefined,
    approvalPolicy: Object.hasOwn(record, 'approvalPolicy')
      ? parseOptional(ApprovalPolicySchema, record.approvalPolicy)
      : undefined,
    chat: isPlainRecord(record.chat)
      ? pickCommandConfig(record.chat)
      : undefined,
    run: isPlainRecord(record.run) ? pickCommandConfig(record.run) : undefined,
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

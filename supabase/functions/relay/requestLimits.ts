import { asFiniteNumber, isJsonRecord, type JsonRecord } from './json.ts';
import {
  isGpt5Model,
  normalizeModelName,
  stripProviderPrefix,
} from './modelNames.ts';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * 1024;

/**
 * Deliberately loose cap: blocks runaway free-tier contexts without policing
 * normal research requests.
 */
export const FREE_TIER_REQUEST_BODY_LIMIT_BYTES = 2 * BYTES_PER_MIB;
export const FREE_TIER_MAX_OUTPUT_TOKENS = 8192;

export interface RequestBodySizeCheck {
  allowed: boolean;
  limitBytes: number;
  requestBytes: number;
}

export type RequestBodyReadResult =
  | (RequestBodySizeCheck & { allowed: true; body: Uint8Array })
  | (RequestBodySizeCheck & { allowed: false; body: null });

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readRequestBodyWithinSizeLimit(
  body: ReadableStream<Uint8Array> | null,
  limitBytes: number = FREE_TIER_REQUEST_BODY_LIMIT_BYTES,
): Promise<RequestBodyReadResult> {
  if (body === null) {
    return {
      allowed: true,
      body: new Uint8Array(),
      limitBytes,
      requestBytes: 0,
    };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let requestBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      requestBytes += value.byteLength;
      if (requestBytes > limitBytes) {
        await reader.cancel();
        return { allowed: false, body: null, limitBytes, requestBytes };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    allowed: true,
    body: concatChunks(chunks, requestBytes),
    limitBytes,
    requestBytes,
  };
}

export function formatRequestBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MIB && bytes % BYTES_PER_MIB === 0) {
    return `${bytes / BYTES_PER_MIB} MiB`;
  }
  if (bytes >= BYTES_PER_KIB && bytes % BYTES_PER_KIB === 0) {
    return `${bytes / BYTES_PER_KIB} KiB`;
  }
  return `${bytes} bytes`;
}

const OPENAI_COMPATIBLE_MAX_OUTPUT_FIELDS = [
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
];

export interface MaxOutputTokenClampResult {
  body: unknown;
  changed: boolean;
  limit: number;
  fieldPath: string | null;
  originalValue: number | null;
}

function clampRecordField(
  record: JsonRecord,
  field: string,
  limit: number,
): { record: JsonRecord; changed: boolean; originalValue: number | null } {
  const current = asFiniteNumber(record[field]) ?? null;
  if (current !== null && current > 0 && current <= limit) {
    return { record, changed: false, originalValue: current };
  }

  return {
    record: { ...record, [field]: limit },
    changed: true,
    originalValue: current,
  };
}

function clampGoogleGenerationConfig(
  body: JsonRecord,
  apiPath: string,
  limit: number,
): MaxOutputTokenClampResult {
  type GoogleGenerationConfigField = {
    config: 'generationConfig' | 'generation_config';
    maxOutput: 'maxOutputTokens' | 'max_output_tokens';
  };
  const endpointNativeField: GoogleGenerationConfigField = apiPath.includes(
    '/interactions',
  )
    ? {
        config: 'generation_config',
        maxOutput: 'max_output_tokens',
      }
    : {
        config: 'generationConfig',
        maxOutput: 'maxOutputTokens',
      };
  const configFields: GoogleGenerationConfigField[] = [];
  if (isJsonRecord(body.generationConfig)) {
    configFields.push({
      config: 'generationConfig',
      maxOutput: 'maxOutputTokens',
    });
  }
  if (isJsonRecord(body.generation_config)) {
    configFields.push({
      config: 'generation_config',
      maxOutput: 'max_output_tokens',
    });
  }
  if (configFields.length === 0) {
    configFields.push(endpointNativeField);
  }

  let nextBody = body;
  let changed = false;
  let firstOriginalValue: number | null = null;
  const changedFields: string[] = [];
  const fieldPaths = configFields.map(
    ({ config, maxOutput }) => `${config}.${maxOutput}`,
  );

  for (const { config, maxOutput } of configFields) {
    const currentConfig = isJsonRecord(nextBody[config])
      ? nextBody[config]
      : {};
    const clamped = clampRecordField(currentConfig, maxOutput, limit);
    if (clamped.changed) {
      nextBody = { ...nextBody, [config]: clamped.record };
      changed = true;
      changedFields.push(`${config}.${maxOutput}`);
      firstOriginalValue ??= clamped.originalValue;
    }
  }

  return {
    body: nextBody,
    changed,
    limit,
    fieldPath: (changed ? changedFields : fieldPaths).join(', '),
    originalValue: firstOriginalValue,
  };
}

function isOpenAICompletionTokenModel(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  if (isGpt5Model(model)) return true;
  const modelName = stripProviderPrefix(normalizeModelName(model));
  return (
    modelName.startsWith('o1') ||
    modelName.startsWith('o3') ||
    modelName.startsWith('o4')
  );
}

function defaultMaxOutputFieldForProvider(
  provider: string,
  apiPath: string,
  body: JsonRecord,
): string {
  if (provider === 'openai' && apiPath.includes('/responses')) {
    return 'max_output_tokens';
  }
  if (
    provider === 'openai' &&
    apiPath.includes('/chat') &&
    isOpenAICompletionTokenModel(body.model)
  ) {
    return 'max_completion_tokens';
  }
  return 'max_tokens';
}

function maxOutputFieldsForProvider(
  provider: string,
  apiPath: string,
  body: JsonRecord,
): string[] {
  const fields = new Set(
    OPENAI_COMPATIBLE_MAX_OUTPUT_FIELDS.filter((field) =>
      Object.hasOwn(body, field),
    ),
  );
  fields.add(defaultMaxOutputFieldForProvider(provider, apiPath, body));
  return [...fields];
}

export function clampFreeTierMaxOutputTokens(
  provider: string,
  apiPath: string,
  body: unknown,
  limit: number = FREE_TIER_MAX_OUTPUT_TOKENS,
): MaxOutputTokenClampResult {
  if (!isJsonRecord(body)) {
    return {
      body,
      changed: false,
      limit,
      fieldPath: null,
      originalValue: null,
    };
  }

  if (provider === 'google') {
    return clampGoogleGenerationConfig(body, apiPath, limit);
  }

  const fields = maxOutputFieldsForProvider(provider, apiPath, body);
  let nextBody = body;
  let changed = false;
  let firstOriginalValue: number | null = null;
  const changedFields: string[] = [];
  for (const field of fields) {
    const clamped = clampRecordField(nextBody, field, limit);
    if (clamped.changed) {
      nextBody = clamped.record;
      changed = true;
      changedFields.push(field);
      firstOriginalValue ??= clamped.originalValue;
    }
  }

  return {
    body: nextBody,
    changed,
    limit,
    fieldPath: (changed ? changedFields : fields).join(', '),
    originalValue: firstOriginalValue,
  };
}

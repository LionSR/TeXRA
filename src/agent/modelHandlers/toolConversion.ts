// Third-party imports
import { toJSONSchema } from 'zod';

// Local imports - agent
import * as logger from '@logger/logUtils';

// Type imports
import type { ToolDefinition } from '@model/ToolDefinition';
import type { LanguageModelToolDefinition } from '@platform/languageModel';

// Local imports - shared
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';

// Type imports - third-party
import type {
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Tool as GeminiTool,
  FunctionDeclaration,
  Schema as GeminiSchema,
} from '@google/genai';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type {
  FunctionTool,
  Tool as OpenAIResponseTool,
} from 'openai/resources/responses/responses';

// ============================================================================
// Shared Tool Conversion Utilities
// ============================================================================

const CHANNEL = 'toolConversion';

type JSONSchemaObject = Record<string, unknown>;

function schemaLiteralValue(schema: JSONSchemaObject): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return schema.enum[0];
  }
  return undefined;
}

/**
 * OpenAI, Gemini, and Anthropic all require function parameter schemas whose
 * top-level node is an object. OpenAI and Gemini also reject schemas whose
 * top-level
 * node is `oneOf`/`anyOf`/`allOf` (HTTP 400:
 * `schema must have type 'object' and not contain 'oneOf'/'anyOf'/'allOf' at the top level`).
 * Zod v4's `toJSONSchema` emits discriminated unions exactly that way. Flatten
 * such unions into a single object schema by:
 *  - merging the union of all branch properties,
 *  - keeping only properties required by every branch as `required`,
 *  - collapsing discriminator literals from every branch into an `enum`.
 *
 * Properties that exist on multiple branches with conflicting non-literal
 * shapes fall back to the first branch's shape; the discriminator enum is
 * what the model actually selects between, so per-branch shape divergence
 * beyond that is rare in practice.
 */
function flattenTopLevelUnion(schema: JSONSchemaObject): JSONSchemaObject {
  const variantKey = (['oneOf', 'anyOf', 'allOf'] as const).find(
    (k) => Array.isArray(schema[k]) && schema.type !== 'object',
  );
  if (!variantKey) return schema;

  const rawVariants = schema[variantKey] as unknown[];
  const variants = rawVariants.filter(
    (v): v is JSONSchemaObject =>
      typeof v === 'object' &&
      v !== null &&
      (v as JSONSchemaObject).type === 'object',
  );
  if (variants.length === 0 || variants.length !== rawVariants.length) {
    return schema;
  }

  const variantProperties: JSONSchemaObject[] = variants.map(
    (v) => (v.properties as JSONSchemaObject | undefined) ?? {},
  );

  const allPropNames = new Set(
    variantProperties.flatMap((props) => Object.keys(props)),
  );

  const mergedProperties: JSONSchemaObject = {};
  for (const name of allPropNames) {
    const branchSchemas = variantProperties
      .map((props) => props[name])
      .filter(
        (s): s is JSONSchemaObject => typeof s === 'object' && s !== null,
      );
    if (branchSchemas.length === 1) {
      mergedProperties[name] = branchSchemas[0];
      continue;
    }
    // Discriminator: every branch pins this prop to a literal value.
    const constValues = branchSchemas
      .map(schemaLiteralValue)
      .filter((value) => value !== undefined);
    if (constValues.length === branchSchemas.length) {
      const descriptions = branchSchemas
        .map((s) => s.description)
        .filter((d): d is string => typeof d === 'string');
      // Infer the discriminator type from the branch shapes rather than
      // hardcoding 'string' — Zod discriminated unions also accept numeric
      // and boolean literal discriminators.
      const branchType = branchSchemas
        .map((s) => (typeof s.type === 'string' ? s.type : undefined))
        .find((t): t is string => t !== undefined);
      const inferredType = branchType ?? typeof constValues[0];
      const merged: JSONSchemaObject = {
        type: inferredType,
        enum: constValues,
      };
      if (descriptions.length) {
        merged.description = descriptions.join(' | ');
      }
      mergedProperties[name] = merged;
      continue;
    }
    mergedProperties[name] = branchSchemas[0];
  }

  const requiredSets = variants.map(
    (v) => new Set<string>((v.required as string[] | undefined) ?? []),
  );
  const commonRequired = [...allPropNames].filter((p) =>
    requiredSets.every((s) => s.has(p)),
  );

  const flat: JSONSchemaObject = {
    type: 'object',
    properties: mergedProperties,
  };
  if (commonRequired.length) flat.required = commonRequired;
  if (typeof schema.description === 'string') {
    flat.description = schema.description;
  }
  return flat;
}

/**
 * OpenAI and Gemini both reject `$schema` at the top level of function
 * parameter schemas. Zod v4's `toJSONSchema` includes this dialect URI by
 * default. Strip it for any provider.
 */
function stripDollarSchema(schema: JSONSchemaObject): JSONSchemaObject {
  if (!('$schema' in schema)) return schema;
  const { $schema: _unused, ...rest } = schema;
  return rest;
}

/**
 * Converts a Zod schema to JSON Schema, or returns the pre-converted parameters.
 * Used by OpenAI Chat Completions, OpenAI Responses, Anthropic, and Gemini function-calling
 * converters: top-level discriminated unions are flattened and `$schema` is
 * stripped so the output passes their schema validators.
 */
export function convertToolSchema(
  def: ToolDefinition,
): JSONSchemaObject | null {
  let schema: JSONSchemaObject | null;
  if (def.zodSchema) {
    schema = toJSONSchema(
      def.zodSchema,
      TOOL_JSON_SCHEMA_OPTIONS,
    ) as JSONSchemaObject;
  } else {
    schema = (def.parameters ?? null) as JSONSchemaObject | null;
  }
  if (!schema) return null;
  return stripDollarSchema(flattenTopLevelUnion(schema));
}

function isSchemaObject(value: unknown): value is JSONSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const GOOGLE_TOOL_JSON_SCHEMA_OPTIONS = Object.freeze({
  ...TOOL_JSON_SCHEMA_OPTIONS,
  target: 'openapi-3.0',
  cycles: 'throw',
} as const);

function containsSchemaReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSchemaReference);
  if (!isSchemaObject(value)) return false;
  return (
    typeof value.$ref === 'string' ||
    Object.entries(value).some(([key, child]) => {
      if (key === 'default' || key === 'example') return false;
      if (
        (key === 'properties' || key === '$defs' || key === 'definitions') &&
        isSchemaObject(child)
      ) {
        return Object.values(child).some(containsSchemaReference);
      }
      return containsSchemaReference(child);
    })
  );
}

/**
 * Convert a tool directly from its canonical Zod schema to the finite OpenAPI
 * subset accepted by Google's model APIs. Recursive references are rejected
 * locally rather than weakened on the wire.
 */
export function convertGoogleToolSchema(
  def: ToolDefinition,
): JSONSchemaObject | null {
  let schema: JSONSchemaObject | null;
  if (def.zodSchema) {
    try {
      schema = toJSONSchema(
        def.zodSchema,
        GOOGLE_TOOL_JSON_SCHEMA_OPTIONS,
      ) as JSONSchemaObject;
    } catch (error) {
      throw new Error(
        `Google tool "${def.name}" must use a finite parameter schema without recursive references.`,
        { cause: error },
      );
    }
  } else {
    schema = (def.parameters ?? null) as JSONSchemaObject | null;
  }
  if (!schema) return null;
  const normalized = stripDollarSchema(flattenTopLevelUnion(schema));
  if (containsSchemaReference(normalized)) {
    throw new Error(
      `Google tool "${def.name}" must use a finite parameter schema without references.`,
    );
  }
  const { $defs: _defs, definitions: _definitions, ...finite } = normalized;
  return toGoogleOpenApiSchemaNode(finite) as JSONSchemaObject;
}

// This mirrors @google/genai's Schema interface. Validation-only JSON Schema
// keywords such as additionalProperties, exclusiveMinimum,
// exclusiveMaximum, and multipleOf are deliberately absent: the SDK does not
// represent them (and independently drops additionalProperties). The original
// Zod schema remains authoritative when TeXRA validates a returned tool call.
const GOOGLE_OPENAPI_SCHEMA_KEY_LIST = [
  'anyOf',
  'default',
  'description',
  'enum',
  'example',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'nullable',
  'pattern',
  'properties',
  'propertyOrdering',
  'required',
  'title',
  'type',
] as const satisfies readonly (keyof GeminiSchema)[];

type AssertNever<T extends never> = T;
type _GoogleSchemaKeysAreExhaustive = AssertNever<
  Exclude<keyof GeminiSchema, (typeof GOOGLE_OPENAPI_SCHEMA_KEY_LIST)[number]>
>;

const GOOGLE_OPENAPI_SCHEMA_KEYS = new Set<string>(
  GOOGLE_OPENAPI_SCHEMA_KEY_LIST,
);
const GOOGLE_SCHEMA_CONVERSION_KEYS = new Set([
  'additionalProperties',
  'const',
  'deprecated',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'readOnly',
  'writeOnly',
]);

/** Keep only the OpenAPI subset represented by the Google SDK's Schema type. */
function toGoogleOpenApiSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGoogleOpenApiSchemaNode);
  if (!isSchemaObject(value)) return value;
  const unsupportedKey = Object.keys(value).find(
    (key) =>
      !GOOGLE_OPENAPI_SCHEMA_KEYS.has(key) &&
      !GOOGLE_SCHEMA_CONVERSION_KEYS.has(key),
  );
  if (unsupportedKey) {
    throw new Error(
      `Google tool schemas do not support the "${unsupportedKey}" keyword.`,
    );
  }
  if (Array.isArray(value.type)) {
    throw new Error('Google tool schemas require a single scalar type.');
  }
  if (
    (value.const !== undefined && typeof value.const !== 'string') ||
    (Array.isArray(value.enum) &&
      value.enum.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error(
      'Google tool schemas support only string literal constraints.',
    );
  }

  if (
    typeof value.const === 'string' &&
    Array.isArray(value.enum) &&
    !value.enum.includes(value.const)
  ) {
    throw new Error(
      'Google tool schemas cannot represent contradictory const and enum constraints.',
    );
  }

  const converted: JSONSchemaObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (!GOOGLE_OPENAPI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'default' || key === 'example') {
      converted[key] = child;
      continue;
    }
    if (key === 'properties' && isSchemaObject(child)) {
      converted.properties = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          toGoogleOpenApiSchemaNode(schema),
        ]),
      );
      continue;
    }
    converted[key] = toGoogleOpenApiSchemaNode(child);
  }

  if (typeof value.const === 'string') {
    converted.enum = [value.const];
  }

  // Google has no exclusive-bound fields, but integer exclusivity can be
  // represented exactly with the adjacent inclusive integer.
  if (value.type === 'integer') {
    let exclusiveMinimum: number | undefined;
    if (typeof value.exclusiveMinimum === 'number') {
      exclusiveMinimum = Math.floor(value.exclusiveMinimum) + 1;
    } else if (
      value.exclusiveMinimum === true &&
      typeof value.minimum === 'number'
    ) {
      exclusiveMinimum = Math.floor(value.minimum) + 1;
    }
    if (exclusiveMinimum !== undefined) {
      converted.minimum =
        typeof converted.minimum === 'number'
          ? Math.max(converted.minimum, exclusiveMinimum)
          : exclusiveMinimum;
    }

    let exclusiveMaximum: number | undefined;
    if (typeof value.exclusiveMaximum === 'number') {
      exclusiveMaximum = Math.ceil(value.exclusiveMaximum) - 1;
    } else if (
      value.exclusiveMaximum === true &&
      typeof value.maximum === 'number'
    ) {
      exclusiveMaximum = Math.ceil(value.maximum) - 1;
    }
    if (exclusiveMaximum !== undefined) {
      converted.maximum =
        typeof converted.maximum === 'number'
          ? Math.min(converted.maximum, exclusiveMaximum)
          : exclusiveMaximum;
    }
  }
  return converted;
}

/**
 * OpenAI tool payloads should always carry an explicit schema object when a
 * tool has no declared parameters to avoid null/omitted ambiguity.
 */
const EMPTY_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function toObjectParametersSchema(
  schema: Record<string, unknown> | null,
  provider: string,
): Record<string, unknown> {
  if (!schema) return EMPTY_TOOL_PARAMETERS_SCHEMA;
  if (schema.type === 'object') return schema;
  if (schema.type !== undefined) {
    logger.warn(
      CHANNEL,
      `${provider} tool parameters must be object schemas; received type "${String(schema.type)}". Falling back to an empty object schema.`,
    );
    return EMPTY_TOOL_PARAMETERS_SCHEMA;
  }
  return { ...schema, type: 'object' };
}

function toOpenAISchemaObject(def: ToolDefinition): Record<string, unknown> {
  return toObjectParametersSchema(convertToolSchema(def), 'OpenAI');
}

// Map local tool names to Anthropic remote tool types.
// The custom `memory` tool (with pin/unpin) is sent as a regular function tool.
// `memory_anthropic` maps to Anthropic's native memory server tool for cases
// where the native implementation is preferred over our custom one.
const ANTHROPIC_TOOL_TYPE_MAP: Record<string, string> = {
  bash: 'bash_20250124',
  str_replace_editor: 'text_editor_20250429',
  web_search: 'web_search_20260209',
  web_fetch: 'web_fetch_20260209',
  memory_anthropic: 'memory_20250818',
};

/** Tools that support dynamic filtering via code execution. */
const DYNAMIC_FILTERING_TOOLS = new Set(['web_search', 'web_fetch']);

/**
 * Convert generic ToolDefinition objects to OpenAI ChatCompletionTool format.
 *
 * Uses convertToolSchema() with unrepresentable: 'any' to handle Zod transforms
 * that cannot be represented in JSON Schema (e.g., default value transforms).
 *
 * Note: We intentionally don't use zodFunction() here because it doesn't support
 * the unrepresentable option, causing failures with tool schemas that use .transform().
 */
export function toOpenAITools(
  defs: ToolDefinition[],
): ChatCompletionFunctionTool[] {
  return defs.map((d): ChatCompletionFunctionTool => {
    const parameters = toOpenAISchemaObject(d);
    return {
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters,
      },
    };
  });
}

/**
 * Options for OpenAI Responses API tool conversion.
 */
interface OpenAIResponseToolOptions {
  /** Whether the model supports native web search. Defaults to false. */
  supportsNativeWebSearch?: boolean;
  /** Whether the model supports function calling. Defaults to true. */
  supportsFunctionCalling?: boolean;
}

/**
 * Convert generic ToolDefinition objects to OpenAI Responses API tool format.
 *
 * NOTE: We intentionally don't use zodResponsesFunction() here because it enables
 * strict mode, which requires all parameters to be required. Tools like Wolfram
 * have optional fields, so we must use strict: false for the Responses API.
 */
export function toOpenAIResponseTools(
  defs: ToolDefinition[],
  options: OpenAIResponseToolOptions = {},
): OpenAIResponseTool[] {
  const { supportsNativeWebSearch = false, supportsFunctionCalling = true } =
    options;
  const tools: OpenAIResponseTool[] = [];

  for (const d of defs) {
    // Handle native web search tool (only if model supports it)
    if (
      d.name === 'web_search' &&
      supportsNativeWebSearch &&
      !d.forceFunctionCall
    ) {
      tools.push({ type: 'web_search' });
      continue;
    }

    // Deep research models only support native tools (web_search, code_interpreter,
    // file_search, mcp) and do NOT support function calling
    if (!supportsFunctionCalling) {
      continue;
    }

    const functionTool: FunctionTool = {
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: toOpenAISchemaObject(d),
      strict: false,
    };
    tools.push(functionTool);
  }

  return tools;
}

/**
 * Options for Anthropic tool conversion.
 */
interface AnthropicToolOptions {
  /** Whether the model supports native web search. Defaults to false. */
  supportsNativeWebSearch?: boolean;
  /** Whether the model supports native web fetch. Defaults to false. */
  supportsNativeWebFetch?: boolean;
  /**
   * Whether to enable dynamic filtering for web_search and web_fetch.
   * When true, Claude can write code to filter results before they enter
   * context (requires a code execution container).
   * When false (default), tools use allowed_callers: ['direct'] to bypass
   * code execution, avoiding the container_id requirement.
   */
  useDynamicFiltering?: boolean;
}

/**
 * Convert generic ToolDefinition objects to Anthropic Tool format.
 */
export function toAnthropicTools(
  defs: ToolDefinition[],
  options: AnthropicToolOptions = {},
): ToolUnion[] {
  const {
    supportsNativeWebSearch = false,
    supportsNativeWebFetch = false,
    useDynamicFiltering = false,
  } = options;

  /** Tools that require an explicit capability flag to use as native. */
  const CONDITIONAL_NATIVE_TOOLS: Record<string, boolean> = {
    web_search: supportsNativeWebSearch,
    web_fetch: supportsNativeWebFetch,
  };

  return defs.map<ToolUnion>((d) => {
    // Check for native/server tools
    const remoteType = d.forceFunctionCall
      ? undefined
      : ANTHROPIC_TOOL_TYPE_MAP[d.name];
    if (remoteType) {
      const gated = CONDITIONAL_NATIVE_TOOLS[d.name];
      // If not gated (undefined) or explicitly enabled, use native tool
      if (gated !== false) {
        // For web tools with dynamic filtering disabled, restrict to direct
        // invocation to avoid requiring a code execution container.
        const needsDirectOnly =
          !useDynamicFiltering && DYNAMIC_FILTERING_TOOLS.has(d.name);
        return {
          name: d.name,
          type: remoteType,
          ...(needsDirectOnly ? { allowed_callers: ['direct'] } : {}),
        } as ToolUnion;
      }
    }

    return {
      name: d.name,
      description: d.description,
      input_schema: toObjectParametersSchema(
        convertToolSchema(d),
        'Anthropic',
      ) as AnthropicTool['input_schema'],
    } as ToolUnion;
  });
}

/**
 * Convert generic ToolDefinition objects to Google Gemini Tool format.
 *
 * NOTE: Native googleSearch is currently disabled because Google's regular
 * content generation API does NOT support combining googleSearch with
 * functionDeclarations - this is a Live API only feature.
 * See: https://ai.google.dev/gemini-api/docs/live-tools
 */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  if (defs.length === 0) return [];

  // The SDK-native `parameters` field (unlike `parametersJsonSchema`) is
  // normalized locally by @google/genai and does not invoke Google's
  // server-side JSON-Schema flattening path.
  const declarations: FunctionDeclaration[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters:
      (convertGoogleToolSchema(d) as GeminiSchema | null) ?? undefined,
  }));

  return [{ functionDeclarations: declarations }];
}

/** Convert generic tool definitions to the host-neutral editor LM format. */
export function toVscodeLmTools(
  defs: ToolDefinition[],
): LanguageModelToolDefinition[] {
  return defs.map((def) => {
    const inputSchema = convertToolSchema(def);
    return {
      name: def.name,
      description: def.description ?? '',
      ...(inputSchema ? { inputSchema } : {}),
    };
  });
}

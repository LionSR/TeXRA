// Third-party imports
import { toJSONSchema } from 'zod';

// Local imports - agent
import * as logger from '@agent/core/logger';

// Type imports
import type { ToolDefinition } from '@model';
import type {
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages';
import type { Tool as GeminiTool, FunctionDeclaration } from '@google/genai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  FunctionTool,
  WebSearchTool,
  Tool as OpenAIResponseTool,
} from 'openai/resources/responses/responses';

// ============================================================================
// Shared Tool Conversion Utilities
// ============================================================================

const CHANNEL = 'toolConversion';
logger.initialize(CHANNEL);

/**
 * Converts a Zod schema to JSON Schema, or returns the pre-converted parameters.
 * Shared utility used by all provider tool converters.
 */
function convertToolSchema(
  def: ToolDefinition,
): Record<string, unknown> | null {
  if (def.zodSchema) {
    return toJSONSchema(def.zodSchema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
      io: 'input',
    }) as Record<string, unknown>;
  }
  return (def.parameters ?? null) as Record<string, unknown> | null;
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

function toOpenAIParametersSchema(
  schema: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!schema) return EMPTY_TOOL_PARAMETERS_SCHEMA;
  if (schema.type === 'object') return schema;
  if (schema.type !== undefined) {
    logger.warn(
      CHANNEL,
      `OpenAI tool parameters must be object schemas; received type "${String(schema.type)}". Falling back to an empty object schema.`,
    );
    return EMPTY_TOOL_PARAMETERS_SCHEMA;
  }
  return { ...schema, type: 'object' };
}

function toOpenAISchemaObject(def: ToolDefinition): Record<string, unknown> {
  return toOpenAIParametersSchema(convertToolSchema(def));
}

// Map local tool names to Anthropic remote tool types.
// The custom `memory` tool (with pin/unpin) is sent as a regular function tool.
// `memory_anthropic` maps to Anthropic's native memory server tool for cases
// where the native implementation is preferred over our custom one.
const ANTHROPIC_TOOL_TYPE_MAP: Record<string, string> = {
  bash: 'bash_20250124',
  str_replace_editor: 'text_editor_20250429',
  str_replace_based_edit_tool: 'text_editor_20250429',
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
export function toOpenAITools(defs: ToolDefinition[]): ChatCompletionTool[] {
  return defs.map((d): ChatCompletionTool => {
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
    if (d.name === 'web_search' && supportsNativeWebSearch) {
      const webSearchTool: WebSearchTool = { type: 'web_search' };
      tools.push(webSearchTool);
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
    const remoteType = ANTHROPIC_TOOL_TYPE_MAP[d.name];
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

    // Use Zod schema with ref support for complex types, else fallback
    const params = d.zodSchema
      ? (toJSONSchema(d.zodSchema, {
          reused: 'ref',
          unrepresentable: 'any',
        }) as AnthropicTool['input_schema'])
      : (d.parameters as AnthropicTool['input_schema'] | undefined);

    return {
      name: d.name,
      description: d.description,
      ...(params ? { input_schema: params } : {}),
    } as ToolUnion;
  });
}

/**
 * Gemini rejects function parameter schemas whose top-level node is
 * `oneOf`/`anyOf`/`allOf` (e.g. discriminated unions emitted by Zod). The API
 * requires `type: "object"` at the root. Flatten such unions into a single
 * object schema by:
 *  - merging the union of all branch properties,
 *  - keeping only properties required by every branch as `required`,
 *  - collapsing discriminator literals from every branch into an `enum`.
 *
 * Properties that exist on multiple branches with conflicting shapes fall
 * back to the first branch's shape; the discriminator enum is what the
 * model actually selects between, so per-branch shape divergence beyond
 * that is rare in practice.
 */
function flattenTopLevelUnionForGemini(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const variantKey = (['oneOf', 'anyOf', 'allOf'] as const).find(
    (k) => Array.isArray(schema[k]) && schema.type !== 'object',
  );
  if (!variantKey) return schema;

  const rawVariants = schema[variantKey] as unknown[];
  const variants: Record<string, unknown>[] = [];
  for (const v of rawVariants) {
    if (typeof v !== 'object' || v === null) return schema;
    const rec = v as Record<string, unknown>;
    if (rec.type !== 'object') return schema;
    variants.push(rec);
  }
  if (variants.length === 0) return schema;

  const allPropNames = new Set<string>();
  for (const v of variants) {
    const props = (v.properties as Record<string, unknown> | undefined) ?? {};
    for (const name of Object.keys(props)) allPropNames.add(name);
  }

  const mergedProperties: Record<string, unknown> = {};
  for (const name of allPropNames) {
    const branchSchemas: Record<string, unknown>[] = [];
    for (const v of variants) {
      const props = (v.properties as Record<string, unknown> | undefined) ?? {};
      const s = props[name];
      if (s && typeof s === 'object') {
        branchSchemas.push(s as Record<string, unknown>);
      }
    }
    if (branchSchemas.length === 1) {
      mergedProperties[name] = branchSchemas[0];
      continue;
    }
    // Discriminator: every branch pins this prop to a literal value.
    const constValues = branchSchemas
      .map((s) => s.const)
      .filter((c) => c !== undefined);
    if (constValues.length === branchSchemas.length) {
      const descriptions = branchSchemas
        .map((s) => s.description)
        .filter((d): d is string => typeof d === 'string');
      const merged: Record<string, unknown> = {
        type: 'string',
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

  const flat: Record<string, unknown> = {
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
 * Gemini rejects `$schema` at the top level of function parameter schemas
 * with HTTP 400 "Unknown name '$schema'". Zod v4's `toJSONSchema` includes
 * this dialect URI by default. Strip it for Gemini specifically.
 */
function stripDollarSchemaForGemini(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!('$schema' in schema)) return schema;
  const { $schema: _unused, ...rest } = schema;
  return rest;
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

  const declarations: FunctionDeclaration[] = defs.map((d) => {
    const schema = convertToolSchema(d);
    const parametersJsonSchema = schema
      ? stripDollarSchemaForGemini(flattenTopLevelUnionForGemini(schema))
      : undefined;
    return {
      name: d.name,
      description: d.description,
      parametersJsonSchema,
    };
  });

  return [{ functionDeclarations: declarations }];
}

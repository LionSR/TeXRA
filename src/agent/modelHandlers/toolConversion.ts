// Third-party imports
import { toJSONSchema } from 'zod';
import { zodFunction, zodResponsesFunction } from 'openai/helpers/zod';

// Type imports
import { hasZodSchema, type ToolDefinition } from '@model';
import type {
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  Tool as GeminiTool,
  FunctionDeclaration,
  Schema,
} from '@google/genai/dist/genai';
import type {
  ChatCompletionTool,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';
import type {
  FunctionTool,
  WebSearchTool,
  Tool as OpenAIResponseTool,
} from 'openai/resources/responses/responses';

// ============================================================================
// Shared Tool Conversion Utilities
// ============================================================================

type JsonSchemaOptions = Parameters<typeof toJSONSchema>[1];

/**
 * Converts the canonical Zod schema to JSON Schema when required by a provider.
 * Falls back to legacy parameters when no Zod schema is attached.
 */
function convertToolSchema(
  def: ToolDefinition,
  options?: JsonSchemaOptions,
): Record<string, unknown> | null {
  if (hasZodSchema(def)) {
    return toJSONSchema(def.zodSchema, options) as Record<string, unknown>;
  }
  return (def.parameters ?? null) as Record<string, unknown> | null;
}

/**
 * Returns the canonical Zod schema when present, otherwise null. This keeps Zod
 * as the single source of truth while still allowing JSON Schema fallbacks for
 * providers that don't yet accept Zod inputs.
 */
function getZodSchema(def: ToolDefinition) {
  if (hasZodSchema(def)) {
    return def.zodSchema;
  }
  return null;
}

// Map local tool names to Anthropic remote tool types
const ANTHROPIC_TOOL_TYPE_MAP: Record<string, string> = {
  bash: 'bash_20250124',
  str_replace_editor: 'text_editor_20250429',
  str_replace_based_edit_tool: 'text_editor_20250429',
  web_search: 'web_search_20250305',
} as const;

/**
 * Convert generic ToolDefinition objects to OpenAI ChatCompletionTool format.
 *
 * When a tool has a zodSchema, uses OpenAI's native zodFunction() helper which keeps
 * Zod as the source of truth and lets the SDK handle schema conversion. Invalid Zod
 * schemas will throw - this is intentional fail-fast behavior.
 */
export function toOpenAITools(defs: ToolDefinition[]): ChatCompletionTool[] {
  return defs.map((d) => {
    // Use native SDK Zod conversion when schema is available
    // zodFunction() returns AutoParseableTool which extends ChatCompletionFunctionTool
    // with additional parsing metadata - structurally compatible with ChatCompletionTool
    if (d.zodSchema) {
      return zodFunction({
        name: d.name,
        description: d.description,
        parameters: d.zodSchema,
      }) as ChatCompletionTool;
    }

    // Fallback to manual conversion for legacy definitions
    // Cast to ChatCompletionFunctionTool since ToolDefinition.parameters
    // is a union type that includes provider-specific schemas
    return {
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: convertToolSchema(d) ?? undefined,
      },
    } as ChatCompletionFunctionTool;
  });
}

/**
 * Options for OpenAI Responses API tool conversion.
 */
export interface OpenAIResponseToolOptions {
  /** Whether the model supports native web search. Defaults to false. */
  supportsNativeWebSearch?: boolean;
  /** Whether the model supports function calling. Defaults to true. */
  supportsFunctionCalling?: boolean;
}

/**
 * Convert generic ToolDefinition objects to OpenAI Responses API tool format.
 *
 * Prefers native Zod helpers when available so the Zod schema remains the single
 * source of truth. Falls back to JSON Schema with strict: false for legacy tools
 * or providers that don't accept Zod inputs directly.
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
      tools.push({ type: 'web_search' } as WebSearchTool);
      continue;
    }

    // Deep research models only support native tools (web_search, code_interpreter,
    // file_search, mcp) and do NOT support function calling
    if (!supportsFunctionCalling) {
      continue;
    }

    const zodSchema = getZodSchema(d);
    if (zodSchema) {
      tools.push(
        zodResponsesFunction({
          name: d.name,
          description: d.description,
          parameters: zodSchema,
        }) as OpenAIResponseTool,
      );
      continue;
    }

    tools.push({
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: convertToolSchema(d),
      strict: false,
    } as FunctionTool);
  }

  return tools;
}

/**
 * Options for Anthropic tool conversion.
 */
export interface AnthropicToolOptions {
  /** Whether the model supports native web search. Defaults to false. */
  supportsNativeWebSearch?: boolean;
}

/**
 * Convert generic ToolDefinition objects to Anthropic Tool format.
 */
export function toAnthropicTools(
  defs: ToolDefinition[],
  options: AnthropicToolOptions = {},
): ToolUnion[] {
  const { supportsNativeWebSearch = false } = options;

  return defs.map<ToolUnion>((d) => {
    // Check for native/server tools
    const remoteType = ANTHROPIC_TOOL_TYPE_MAP[d.name];
    if (remoteType && (d.name !== 'web_search' || supportsNativeWebSearch)) {
      return { name: d.name, type: remoteType } as ToolUnion;
    }

    // Use Zod schema with ref support for complex types, else fallback
    const params = convertToolSchema(d, {
      reused: 'ref',
    }) as AnthropicTool['input_schema'] | undefined;

    return {
      name: d.name,
      description: d.description,
      ...(params ? { input_schema: params } : {}),
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
  if (defs.length === 0) {
    return [];
  }

  const declarations: FunctionDeclaration[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: (convertToolSchema(d) ?? undefined) as Schema | undefined,
  }));

  return [{ functionDeclarations: declarations }];
}

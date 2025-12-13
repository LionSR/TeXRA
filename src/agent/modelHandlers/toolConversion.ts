// Third-party imports
import { toJSONSchema } from 'zod';
import { zodFunction, zodResponsesFunction } from 'openai/helpers/zod';

// Type imports
import type { ToolDefinition } from '@model';
import type {
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  Tool as GeminiTool,
  FunctionDeclaration,
  Schema,
  GoogleSearch,
} from '@google/genai/dist/genai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  FunctionTool,
  WebSearchTool,
  Tool as OpenAIResponseTool,
} from 'openai/resources/responses/responses';

// Local imports - agent
// Local imports - types

// ============================================================================
// Native/Server Tool Configuration
// ============================================================================

/**
 * Tools that are executed server-side by the provider.
 * These don't need local implementations - the provider handles them.
 */
export const NATIVE_TOOL_NAMES = new Set(['web_search']);

/**
 * Check if a tool is a native/server-side tool.
 */
export function isNativeTool(name: string): boolean {
  return NATIVE_TOOL_NAMES.has(name);
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
 * When a tool has a zodSchema, uses OpenAI's native zodFunction() helper which:
 * - Converts Zod schema to JSON Schema using SDK's optimized conversion
 * - Enables strict mode for better type safety
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
    return {
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: d.parameters,
      },
    };
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
 * When a tool has a zodSchema, uses OpenAI's native zodResponsesFunction() helper which:
 * - Converts Zod schema to JSON Schema using SDK's optimized conversion
 * - Enables strict mode for better type safety
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
      tools.push({
        type: 'web_search',
      } as WebSearchTool);
      continue;
    }

    // Deep research models only support native tools (web_search, code_interpreter,
    // file_search, mcp) and do NOT support function calling. When function calling
    // is disabled, skip all remaining tools - they cannot be converted to function
    // format, and native conversion for tools other than web_search is not yet
    // implemented.
    if (!supportsFunctionCalling) {
      continue;
    }

    // Use native SDK Zod conversion when schema is available
    // zodResponsesFunction() returns AutoParseableResponseTool which extends FunctionTool
    // with additional parsing metadata - structurally compatible with OpenAIResponseTool
    if (d.zodSchema) {
      tools.push(
        zodResponsesFunction({
          name: d.name,
          description: d.description,
          parameters: d.zodSchema,
        }) as OpenAIResponseTool,
      );
      continue;
    }

    // Fallback to manual conversion for legacy definitions
    const params = (d.parameters ?? null) as Record<string, unknown> | null;
    tools.push({
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: params,
      // Setting strict=true requires an explicit `required` array covering all
      // parameters. The Wolfram tool uses optional fields, so disable strict
      // validation to avoid schema errors from the OpenAI Responses API.
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
 *
 * When a tool has a zodSchema, uses Zod's native toJSONSchema() which:
 * - Converts Zod schema directly to JSON Schema
 * - Uses the same conversion pattern as Anthropic's betaZodTool() helper
 */
export function toAnthropicTools(
  defs: ToolDefinition[],
  options: AnthropicToolOptions = {},
): ToolUnion[] {
  const { supportsNativeWebSearch = false } = options;

  return defs.map<ToolUnion>((d) => {
    // Only use native tool types if the model supports them
    const remoteType = ANTHROPIC_TOOL_TYPE_MAP[d.name];
    if (remoteType) {
      // web_search requires native support check
      if (d.name === 'web_search' && !supportsNativeWebSearch) {
        // Fall through to create as regular function tool
      } else {
        return {
          name: d.name,
          type: remoteType,
        } as ToolUnion;
      }
    }

    // Use native Zod conversion when schema is available
    // This mirrors the Anthropic SDK's betaZodTool() implementation
    if (d.zodSchema) {
      const jsonSchema = toJSONSchema(d.zodSchema, { reused: 'ref' });
      return {
        name: d.name,
        description: d.description,
        input_schema: jsonSchema as AnthropicTool['input_schema'],
      } as ToolUnion;
    }

    // Fallback to pre-converted parameters for legacy definitions
    const params = d.parameters as AnthropicTool['input_schema'] | undefined;
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
 *
 * When a tool has a zodSchema, uses Zod's native toJSONSchema() for conversion.
 * All tools (including web_search) are converted to function declarations.
 *
 * @param defs Tool definitions to convert
 */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  if (defs.length === 0) {
    return [];
  }

  // Convert all tools to function declarations
  // Native googleSearch is disabled until Live API support is added
  const declarations: FunctionDeclaration[] = defs.map((d) => {
    // Use native Zod conversion when schema is available
    if (d.zodSchema) {
      return {
        name: d.name,
        description: d.description,
        parameters: toJSONSchema(d.zodSchema) as Schema | undefined,
      };
    }

    // Fallback to pre-converted parameters for legacy definitions
    return {
      name: d.name,
      description: d.description,
      parameters: d.parameters as Schema | undefined,
    };
  });

  return [{ functionDeclarations: declarations }];
}

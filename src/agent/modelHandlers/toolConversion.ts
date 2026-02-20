// Third-party imports
import { toJSONSchema } from 'zod';

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
} from '@google/genai/dist/genai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  FunctionTool,
  WebSearchTool,
  Tool as OpenAIResponseTool,
} from 'openai/resources/responses/responses';

// ============================================================================
// Shared Tool Conversion Utilities
// ============================================================================

/**
 * Converts a Zod schema to JSON Schema, or returns the pre-converted parameters.
 * Shared utility used by all provider tool converters.
 */
function convertToolSchema(
  def: ToolDefinition,
): Record<string, unknown> | null {
  if (def.zodSchema) {
    return toJSONSchema(def.zodSchema, {
      unrepresentable: 'any',
    }) as Record<string, unknown>;
  }
  return (def.parameters ?? null) as Record<string, unknown> | null;
}

// Map local tool names to Anthropic remote tool types (excluding web_search, handled separately)
const ANTHROPIC_TOOL_TYPE_MAP: Record<string, string> = {
  bash: 'bash_20250124',
  str_replace_editor: 'text_editor_20250429',
  str_replace_based_edit_tool: 'text_editor_20250429',
  memory: 'memory_20250818',
};

/** Web search tool type versions */
const WEB_SEARCH_BASIC = 'web_search_20250305' as const;
const WEB_SEARCH_DYNAMIC_FILTERING = 'web_search_20260209' as const;

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
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: convertToolSchema(d),
    },
  })) as ChatCompletionTool[];
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
      tools.push({ type: 'web_search' } as WebSearchTool);
      continue;
    }

    // Deep research models only support native tools (web_search, code_interpreter,
    // file_search, mcp) and do NOT support function calling
    if (!supportsFunctionCalling) {
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
 * Web search configuration options for Anthropic API.
 * Controls domain filtering, usage limits, and result localization.
 */
export interface WebSearchConfig {
  /** Only include results from these domains (cannot be used with blockedDomains). */
  allowedDomains?: string[];
  /** Never include results from these domains (cannot be used with allowedDomains). */
  blockedDomains?: string[];
  /** Maximum number of searches per request. */
  maxUses?: number;
  /** User location for localizing search results. */
  userLocation?: {
    type: 'approximate';
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

/**
 * Options for Anthropic tool conversion.
 */
export interface AnthropicToolOptions {
  /** Whether the model supports native web search. Defaults to false. */
  supportsNativeWebSearch?: boolean;
  /** Whether the model supports dynamic filtering web search (web_search_20260209). Defaults to false. */
  supportsDynamicFilteringWebSearch?: boolean;
  /** Web search configuration (domain filtering, max uses, localization). */
  webSearchConfig?: WebSearchConfig;
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
    supportsDynamicFilteringWebSearch = false,
    webSearchConfig,
  } = options;

  return defs.map<ToolUnion>((d) => {
    // Handle native web search tool with version selection
    if (d.name === 'web_search' && supportsNativeWebSearch) {
      return buildAnthropicWebSearchTool(
        supportsDynamicFilteringWebSearch,
        webSearchConfig,
      );
    }

    // Check for other native/server tools
    const remoteType = ANTHROPIC_TOOL_TYPE_MAP[d.name];
    if (remoteType) {
      return { name: d.name, type: remoteType } as ToolUnion;
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
 * Build the Anthropic web search server tool with the appropriate version
 * and optional configuration (domain filtering, max uses, localization).
 */
function buildAnthropicWebSearchTool(
  supportsDynamicFiltering: boolean,
  config?: WebSearchConfig,
): ToolUnion {
  const toolType = supportsDynamicFiltering
    ? WEB_SEARCH_DYNAMIC_FILTERING
    : WEB_SEARCH_BASIC;

  const tool: Record<string, unknown> = {
    name: 'web_search',
    type: toolType,
  };

  if (config) {
    if (config.allowedDomains && config.allowedDomains.length > 0) {
      tool.allowed_domains = config.allowedDomains;
    }
    if (config.blockedDomains && config.blockedDomains.length > 0) {
      tool.blocked_domains = config.blockedDomains;
    }
    if (config.maxUses !== undefined && config.maxUses !== null) {
      tool.max_uses = config.maxUses;
    }
    if (config.userLocation) {
      tool.user_location = config.userLocation;
    }
  }

  return tool as unknown as ToolUnion;
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

  const declarations: FunctionDeclaration[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: convertToolSchema(d) as Schema | undefined,
  }));

  return [{ functionDeclarations: declarations }];
}

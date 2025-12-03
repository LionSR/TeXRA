// Third-party imports
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

/** Convert generic ToolDefinition objects to OpenAI ChatCompletionTool format. */
export function toOpenAITools(defs: ToolDefinition[]): ChatCompletionTool[] {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

/** Convert generic ToolDefinition objects to OpenAI Responses API tool format. */
export function toOpenAIResponseTools(
  defs: ToolDefinition[],
): OpenAIResponseTool[] {
  const tools: OpenAIResponseTool[] = [];

  for (const d of defs) {
    // Handle native web search tool
    if (d.name === 'web_search') {
      tools.push({
        type: 'web_search',
      } as WebSearchTool);
      continue;
    }

    // Standard function tools
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

/** Convert generic ToolDefinition objects to Anthropic Tool format. */
export function toAnthropicTools(defs: ToolDefinition[]): ToolUnion[] {
  return defs.map<ToolUnion>((d) => {
    const remoteType = ANTHROPIC_TOOL_TYPE_MAP[d.name];
    if (remoteType) {
      return {
        name: d.name,
        type: remoteType,
      } as ToolUnion;
    }

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
 * Handles both function declarations and native Google Search grounding.
 */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  if (defs.length === 0) {
    return [];
  }

  const tools: GeminiTool[] = [];
  const functionDefs: ToolDefinition[] = [];

  for (const d of defs) {
    // Handle native Google Search grounding
    if (d.name === 'web_search') {
      tools.push({
        googleSearch: {} as GoogleSearch,
      });
      continue;
    }

    functionDefs.push(d);
  }

  // Add function declarations if any non-native tools exist
  if (functionDefs.length > 0) {
    const declarations: FunctionDeclaration[] = functionDefs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters as Schema | undefined,
    }));

    tools.push({
      functionDeclarations: declarations,
    });
  }

  return tools;
}

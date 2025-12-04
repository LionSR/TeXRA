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
} from '@google/genai/dist/genai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { FunctionTool } from 'openai/resources/responses/responses';

// Local imports - agent
// Local imports - types

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

/** Convert generic ToolDefinition objects to OpenAI Responses FunctionTool format. */
export function toOpenAIResponseTools(defs: ToolDefinition[]): FunctionTool[] {
  return defs.map((d) => {
    const params = (d.parameters ?? null) as Record<string, unknown> | null;
    return {
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: params,
      // Setting strict=true requires an explicit `required` array covering all
      // parameters. The Wolfram tool uses optional fields, so disable strict
      // validation to avoid schema errors from the OpenAI Responses API.
      strict: false,
    };
  });
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

// Names of tools that should be converted to Google's native tool types
// rather than function declarations
const GOOGLE_NATIVE_TOOLS = new Set(['web_search', 'code_execution']);

/** Convert generic ToolDefinition objects to Google Gemini Tool format.
 *
 * Google's API supports two categories of tools:
 * 1. Function declarations - custom tools implemented by the application
 * 2. Native tools - built-in tools like googleSearch and codeExecution
 *
 * Native tools must be configured separately and cannot be mixed with
 * function declarations in the same Tool object. This function filters
 * out native tools and configures them appropriately.
 */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  if (defs.length === 0) {
    return [];
  }

  // Separate native Google tools from custom function declarations
  const customTools = defs.filter((d) => !GOOGLE_NATIVE_TOOLS.has(d.name));
  const hasWebSearch = defs.some((d) => d.name === 'web_search');
  const hasCodeExecution = defs.some((d) => d.name === 'code_execution');

  const result: GeminiTool[] = [];

  // Add function declarations for custom tools
  if (customTools.length > 0) {
    const declarations: FunctionDeclaration[] = customTools.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters as Schema | undefined,
    }));
    result.push({ functionDeclarations: declarations });
  }

  // Add native Google Search tool if web_search was requested
  if (hasWebSearch) {
    result.push({ googleSearch: {} });
  }

  // Add native Code Execution tool if code_execution was requested
  if (hasCodeExecution) {
    result.push({ codeExecution: {} });
  }

  return result;
}

// Third-party imports
import type {
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  Tool as GeminiTool,
  FunctionDeclaration,
  Schema,
} from '@google/genai/dist/genai';

// Third-party imports
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { FunctionTool } from 'openai/resources/responses/responses';

// Local imports - agent
// Local imports - types
import type { ToolDefinition } from '@model';

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
      parameters: d.inputSchema as Record<string, unknown> | undefined,
    },
  }));
}

/** Convert generic ToolDefinition objects to OpenAI Responses FunctionTool format. */
export function toOpenAIResponseTools(defs: ToolDefinition[]): FunctionTool[] {
  return defs.map((d) => {
    const params = (d.inputSchema ?? null) as Record<string, unknown> | null;
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

    const params = d.inputSchema as AnthropicTool['input_schema'] | undefined;
    return {
      name: d.name,
      description: d.description,
      ...(params ? { input_schema: params } : {}),
    } as ToolUnion;
  });
}

/** Convert generic ToolDefinition objects to Google Gemini Tool format. */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  if (defs.length === 0) {
    return [];
  }

  const declarations: FunctionDeclaration[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.inputSchema as unknown as Schema | undefined,
  }));

  return [
    {
      functionDeclarations: declarations,
    },
  ];
}

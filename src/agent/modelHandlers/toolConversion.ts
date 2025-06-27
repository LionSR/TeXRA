// Local imports - types
import type { ToolDefinition } from '@model';

// Third-party imports
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  Tool as GeminiTool,
  FunctionDeclaration,
} from '@google/genai/dist/genai';

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

/** Convert generic ToolDefinition objects to Anthropic Tool format. */
export function toAnthropicTools(defs: ToolDefinition[]): AnthropicTool[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: (d.parameters ?? {}) as AnthropicTool['input_schema'],
  }));
}

/** Convert generic ToolDefinition objects to Google Gemini Tool format. */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  return defs.map((d) => {
    const decl: FunctionDeclaration = {
      name: d.name,
      description: d.description,
      parameters: d.parameters as any,
    };
    return { functionDeclarations: [decl] };
  });
}

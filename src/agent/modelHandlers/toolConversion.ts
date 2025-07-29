// Local imports - types
import type { ToolDefinition } from '@model';

// Third-party imports
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  Tool as AnthropicTool,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  Tool as GeminiTool,
  FunctionDeclaration,
  Schema,
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
export function toAnthropicTools(defs: ToolDefinition[]): ToolUnion[] {
  return defs.map<ToolUnion>(
    (d) =>
      ({
        name: d.name,
        description: d.description,
        // Include the provider specific type when present to support
        // Anthropic's built-in tools like the text editor.
        ...(d.type ? { type: d.type } : { type: 'custom' }),
        input_schema: (d.parameters ?? {}) as AnthropicTool['input_schema'],
      }) as unknown as ToolUnion,
  );
}

/** Convert generic ToolDefinition objects to Google Gemini Tool format. */
export function toGoogleTools(defs: ToolDefinition[]): GeminiTool[] {
  if (defs.length === 0) {
    return [];
  }

  const declarations: FunctionDeclaration[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters as Schema | undefined,
  }));

  return [
    {
      functionDeclarations: declarations,
    },
  ];
}

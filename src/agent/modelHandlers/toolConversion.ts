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
  return defs.map<ToolUnion>((d) => {
    if (d.type) {
      const def: Record<string, any> = { name: d.name, type: d.type };
      if (d.max_characters) {
        def.max_characters = d.max_characters;
      }
      return def as ToolUnion;
    }
    return {
      name: d.name,
      description: d.description,
      input_schema: (d.parameters ?? {}) as AnthropicTool['input_schema'],
      type: 'custom',
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
    parameters: d.parameters as Schema | undefined,
  }));

  return [
    {
      functionDeclarations: declarations,
    },
  ];
}

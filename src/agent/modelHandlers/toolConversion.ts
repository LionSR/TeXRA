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
    let inputSchema = (d.parameters ?? {}) as AnthropicTool['input_schema'];

    // Anthropic expects the schema object itself, not a `$ref` wrapper.
    if (
      typeof inputSchema === 'object' &&
      inputSchema !== null &&
      '$ref' in inputSchema &&
      typeof (inputSchema as any).$ref === 'string' &&
      'definitions' in inputSchema
    ) {
      const ref = (inputSchema as any).$ref as string;
      const key = ref.replace(/^#\/definitions\//, '');
      const definitions = (inputSchema as any).definitions as Record<
        string,
        unknown
      >;
      if (definitions && key in definitions) {
        inputSchema = definitions[key] as AnthropicTool['input_schema'];
      }
    }

    return {
      name: d.name,
      description: d.description,
      input_schema: inputSchema,
    };
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

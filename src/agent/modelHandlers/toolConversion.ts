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
import type {
  FunctionTool,
  WebSearchTool,
} from 'openai/resources/responses/responses';

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
      parameters: d.parameters,
    },
  }));
}

const OPENAI_WEB_SEARCH_TYPE_MAP: Record<string, WebSearchTool['type']> = {
  web_search: 'web_search',
  web_search_2025_08_26: 'web_search_2025_08_26',
  web_search_preview: 'web_search_2025_08_26',
};

export interface OpenAIResponseToolOptions {
  supportsNativeWebSearch?: boolean;
}

function isJsonSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === 'string' && candidate.type.length > 0;
}

function toWebSearchTool(
  name: string,
  parameters: ToolDefinition['parameters'],
): WebSearchTool | null {
  const mappedType = OPENAI_WEB_SEARCH_TYPE_MAP[name];
  if (!mappedType) {
    return null;
  }
  if (parameters && isJsonSchema(parameters)) {
    // If a JSON schema sneaks through, fall back to function calling.
    return null;
  }

  return {
    type: mappedType,
  } satisfies WebSearchTool;
}

/** Convert generic ToolDefinition objects to OpenAI Responses tool format. */
export function toOpenAIResponseTools(
  defs: ToolDefinition[],
  options?: OpenAIResponseToolOptions,
): Array<FunctionTool | WebSearchTool> {
  const supportsNativeWebSearch = Boolean(options?.supportsNativeWebSearch);

  return defs.map((d) => {
    if (supportsNativeWebSearch) {
      const webSearchTool = toWebSearchTool(d.name, d.parameters);
      if (webSearchTool) {
        return webSearchTool;
      }
    }

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
    } satisfies FunctionTool;
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

export interface GoogleToolOptions {
  supportsNativeWebSearch?: boolean;
}

const GOOGLE_NATIVE_WEB_SEARCH_NAMES = new Set([
  'web_search',
  'google_web_search',
]);

/** Convert generic ToolDefinition objects to Google Gemini Tool format. */
export function toGoogleTools(
  defs: ToolDefinition[],
  options?: GoogleToolOptions,
): GeminiTool[] {
  if (defs.length === 0) {
    return [];
  }

  const declarations: FunctionDeclaration[] = [];
  let hasNativeWebSearch = false;

  for (const def of defs) {
    if (options?.supportsNativeWebSearch && GOOGLE_NATIVE_WEB_SEARCH_NAMES.has(def.name)) {
      hasNativeWebSearch = true;
      continue;
    }

    declarations.push({
      name: def.name,
      description: def.description,
      parameters: def.parameters as Schema | undefined,
    });
  }

  const tool: GeminiTool = {};
  if (declarations.length > 0) {
    tool.functionDeclarations = declarations;
  }
  if (hasNativeWebSearch) {
    tool.googleSearch = {};
  }

  return tool.functionDeclarations || tool.googleSearch ? [tool] : [];
}

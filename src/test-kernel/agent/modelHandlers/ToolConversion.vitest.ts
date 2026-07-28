import { strict as assert } from 'node:assert';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  toAnthropicTools,
  toGoogleTools,
  toOpenAITools,
  toOpenAIResponseTools,
} from '@agent/modelHandlers/toolConversion';
import type { ToolDefinition } from '@model';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';
import { BashTool } from '@tools/bash';
import { EditFileTool } from '@tools/EditTool';
import { GlobTool } from '@tools/glob';
import { GrepTool } from '@tools/grep';
import { ReadFileTool } from '@tools/ReadTool';
import { WriteFileTool } from '@tools/WriteTool';
import { ArxivDownloadTool } from '@tools/arxiv/ArxivDownloadTool';
import { ArxivMetadataTool } from '@tools/arxiv/ArxivMetadataTool';
import { ArxivSearchTool } from '@tools/arxiv/ArxivSearchTool';
import { CrossrefSearchTool } from '@tools/citation/CrossrefSearchTool';
import { TexcountTool } from '@tools/texcount/TexcountTool';
import { WebFetchTool } from '@tools/web/WebFetchTool';
import { WebSearchTool } from '@tools/web/WebSearchTool';
import type { Tool as GeminiTool } from '@google/genai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { FunctionTool } from 'openai/resources/responses/responses';

type OpenAIFunctionTool = Extract<ChatCompletionTool, { type: 'function' }>;
type JsonSchemaWithProperties = {
  description?: unknown;
  properties?: Record<string, JsonSchemaWithProperties>;
  anyOf?: JsonSchemaWithProperties[];
  oneOf?: JsonSchemaWithProperties[];
  allOf?: JsonSchemaWithProperties[];
};
type DescriptionPath = readonly string[];
type ToolDescriptionCase = {
  readonly definition: ToolDefinition;
  readonly fields: readonly string[];
  readonly nestedFields?: readonly DescriptionPath[];
};

function propertySchema(
  schema: JsonSchemaWithProperties | undefined,
  field: string,
): JsonSchemaWithProperties | undefined {
  const directProperty = schema?.properties?.[field];
  if (directProperty) return directProperty;

  for (const branch of [
    ...(schema?.anyOf ?? []),
    ...(schema?.oneOf ?? []),
    ...(schema?.allOf ?? []),
  ]) {
    const nestedProperty = propertySchema(branch, field);
    if (nestedProperty) return nestedProperty;
  }

  return undefined;
}

function schemaAtPath(
  parameters: unknown,
  path: DescriptionPath,
): JsonSchemaWithProperties | undefined {
  let schema = parameters as JsonSchemaWithProperties | undefined;
  for (const segment of path) {
    schema = propertySchema(schema, segment);
  }
  return schema;
}

function expectDescribedParameters(
  toolName: string,
  parameters: unknown,
  paths: readonly DescriptionPath[],
): void {
  for (const path of paths) {
    const field = path.join('.');
    const description = schemaAtPath(parameters, path)?.description;
    expect(typeof description, `${toolName}.${field}`).toBe('string');
    expect(
      (description as string).length,
      `${toolName}.${field}`,
    ).toBeGreaterThan(0);
  }
}

function expectDescribedProperties(
  definition: ToolDefinition,
  paths: readonly DescriptionPath[],
): void {
  expectDescribedParameters(definition.name, definition.parameters, paths);
}

function descriptionPaths(testCase: ToolDescriptionCase): DescriptionPath[] {
  return [
    ...testCase.fields.map((field) => [field] as const),
    ...(testCase.nestedFields ?? []),
  ];
}

describe('OpenAI tool conversion', () => {
  it('flattens discriminated object unions into a single object schema', () => {
    // OpenAI's function-calling API rejects schemas whose root is
    // oneOf/anyOf/allOf with HTTP 400 "Invalid function 'X': schema must have
    // type 'object' and not contain 'oneOf'/'anyOf'/'allOf' at the top level."
    // Zod v4 emits z.discriminatedUnion as a top-level oneOf, so the union
    // must be flattened before the schema reaches OpenAI.
    const defs: ToolDefinition[] = [
      {
        name: 'inquiry',
        description: 'Ask or read',
        zodSchema: z.discriminatedUnion('command', [
          z.object({
            command: z.literal('ask'),
            question: z.string(),
          }),
          z.object({
            command: z.literal('read'),
            thread_id: z.string(),
          }),
        ]),
      },
    ];

    const tools = toOpenAITools(defs);
    const tool = tools[0] as OpenAIFunctionTool;
    const parameters = tool.function.parameters as Record<string, unknown>;

    expect(parameters.type).toBe('object');
    expect(parameters.oneOf).toBeUndefined();
    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.allOf).toBeUndefined();
    expect(parameters.$schema).toBeUndefined();

    const properties = parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.command.enum).toEqual(['ask', 'read']);
    expect(properties.question).toBeDefined();
    expect(properties.thread_id).toBeDefined();
    expect(parameters.required).toEqual(['command']);
  });

  it('uses an empty object schema when parameters are omitted', () => {
    const tools = toOpenAIResponseTools([
      {
        name: 'noop',
        description: 'No parameters',
      },
    ]);

    const tool = tools[0] as FunctionTool;
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('does not silently coerce non-object parameter schemas', () => {
    const tools = toOpenAITools([
      {
        name: 'bad_params',
        description: 'Invalid parameter shape',
        parameters: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    ]);

    const tool = tools[0] as OpenAIFunctionTool;
    expect(tool.function.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('Anthropic tool conversion', () => {
  it('uses an empty object input schema when parameters are omitted', () => {
    const tools = toAnthropicTools([
      {
        name: 'noop',
        description: 'No parameters',
      },
    ]);

    expect(tools[0]).toMatchObject({
      name: 'noop',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it('flattens discriminated object unions into a typed object schema', () => {
    const tools = toAnthropicTools([
      {
        name: 'inquiry',
        description: 'Ask or read',
        zodSchema: z.discriminatedUnion('command', [
          z.object({
            command: z.literal('ask'),
            question: z.string(),
          }),
          z.object({
            command: z.literal('read'),
            thread_id: z.string(),
          }),
        ]),
      },
    ]);

    const tool = tools[0] as { input_schema?: Record<string, unknown> };
    const inputSchema = tool.input_schema;

    expect(inputSchema?.type).toBe('object');
    expect(inputSchema?.oneOf).toBeUndefined();
    expect(inputSchema?.anyOf).toBeUndefined();
    expect(inputSchema?.allOf).toBeUndefined();
    expect(inputSchema?.$schema).toBeUndefined();

    const properties = inputSchema?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.command.enum).toEqual(['ask', 'read']);
    expect(properties.question).toBeDefined();
    expect(properties.thread_id).toBeDefined();
    expect(inputSchema?.required).toEqual(['command']);
  });

  it('emits valid object input schemas for the first CLI chat tools', () => {
    const definitions = [
      new BashTool().definition,
      new ReadFileTool().definition,
      new WriteFileTool().definition,
      new EditFileTool().definition,
      new GlobTool().definition,
      new GrepTool().definition,
    ];

    const tools = toAnthropicTools(definitions);
    const customTools = tools.flatMap((tool) =>
      'type' in tool
        ? []
        : [
            tool as unknown as {
              name: string;
              input_schema: Record<string, unknown>;
            },
          ],
    );

    expect(customTools.map((tool) => tool.name)).toContain('grep');
    for (const tool of customTools) {
      expect(tool.input_schema?.type, tool.name).toBe('object');
    }
  });
});

describe('tool schema descriptions', () => {
  it('keeps LLM-facing input fields described through provider conversions', () => {
    const cases: ToolDescriptionCase[] = [
      {
        definition: new ArxivDownloadTool().definition,
        fields: ['id', 'autoIndent', 'destination'],
      },
      {
        definition: new ArxivMetadataTool().definition,
        fields: ['id', 'includeAbstract', 'maxAuthors'],
      },
      {
        definition: new ArxivSearchTool().definition,
        fields: [
          'query',
          'field',
          'categories',
          'maxResults',
          'start',
          'sortBy',
          'sortOrder',
        ],
      },
      {
        definition: new CrossrefSearchTool().definition,
        fields: [
          'command',
          'query',
          'rows',
          'offset',
          'sort',
          'order',
          'filter',
          'doi',
        ],
      },
      {
        definition: new DiagnosticsTool().definition,
        fields: ['command', 'path'],
      },
      {
        definition: new EditFileTool().definition,
        fields: ['path', 'old_str', 'new_str', 'replace_all'],
      },
      { definition: new GlobTool().definition, fields: ['pattern', 'path'] },
      {
        definition: new ReadFileTool().definition,
        fields: ['path', 'range'],
        nestedFields: [
          ['range', 'start'],
          ['range', 'end'],
        ],
      },
      {
        definition: new TexcountTool().definition,
        fields: ['files', 'mode', 'format'],
      },
      { definition: new WebFetchTool().definition, fields: ['url', 'prompt'] },
      {
        definition: new WebSearchTool().definition,
        fields: ['query', 'max_results'],
      },
    ];

    for (const testCase of cases) {
      expectDescribedProperties(
        testCase.definition,
        descriptionPaths(testCase),
      );
    }

    const definitions = cases.map(({ definition }) => definition);
    const anthropicByName = new Map(
      toAnthropicTools(definitions).flatMap((tool) =>
        'type' in tool ? [] : [[tool.name, tool.input_schema] as const],
      ),
    );
    const openAiByName = new Map(
      toOpenAITools(definitions).flatMap((tool) =>
        tool.type === 'function'
          ? [[tool.function.name, tool.function.parameters] as const]
          : [],
      ),
    );
    const openAiResponseByName = new Map(
      toOpenAIResponseTools(definitions).flatMap((tool) =>
        tool.type === 'function' ? [[tool.name, tool.parameters] as const] : [],
      ),
    );

    for (const testCase of cases) {
      const { definition } = testCase;
      const paths = descriptionPaths(testCase);

      expectDescribedParameters(
        `${definition.name} anthropic`,
        anthropicByName.get(definition.name),
        paths,
      );
      expectDescribedParameters(
        `${definition.name} openai`,
        openAiByName.get(definition.name),
        paths,
      );
      expectDescribedParameters(
        `${definition.name} openai-response`,
        openAiResponseByName.get(definition.name),
        paths,
      );
    }
  });
});

describe('Crossref provider schema compatibility', () => {
  it('accepts flattened fields from the inactive command branch', () => {
    const schema = new CrossrefSearchTool().definition.zodSchema;

    expect(
      schema?.safeParse({
        command: 'search',
        query: 'attention',
        doi: '10.1000/ignored',
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        command: 'doi',
        doi: '10.1000/example',
        query: 'ignored',
      }).success,
    ).toBe(true);
  });

  it('still requires the selected branch and rejects unknown fields', () => {
    const schema = new CrossrefSearchTool().definition.zodSchema;

    expect(schema?.safeParse({ command: 'search' }).success).toBe(false);
    expect(schema?.safeParse({ command: 'doi' }).success).toBe(false);
    expect(
      schema?.safeParse({
        command: 'search',
        query: 'attention',
        unknown: true,
      }).success,
    ).toBe(false);
  });
});

describe('toOpenAITools additional coverage', () => {
  it('leaves Chat Completions function tools non-strict', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'delegate_workflow',
        description: 'Delegate workflow',
        parameters: {
          type: 'object',
          properties: { instruction: { type: 'string' } },
          required: ['instruction'],
          additionalProperties: false,
        },
      },
    ];

    const tools = toOpenAITools(defs);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].function.name, 'delegate_workflow');
    assert.equal(tools[0].function.strict, undefined);
  });
});

describe('toOpenAIResponseTools', () => {
  it('converts tool definitions to Response API format', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'echo',
        description: 'Echo value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, 'echo');
    assert.deepEqual(tool.parameters, defs[0].parameters);
  });

  // web_search collapses to the native WebSearchTool when (and only when) the
  // model supports it, regardless of whether function calling is also enabled.
  it.each([
    {
      label:
        'converts web_search to native WebSearchTool when supportsNativeWebSearch is true',
      defs: [{ name: 'web_search', description: 'Search the web' }],
      options: { supportsNativeWebSearch: true },
    },
    {
      label:
        'keeps native web_search when supportsFunctionCalling is false and supportsNativeWebSearch is true',
      defs: [
        { name: 'web_search', description: 'Search the web' },
        { name: 'read_file', description: 'Read a file' },
      ],
      options: {
        supportsFunctionCalling: false,
        supportsNativeWebSearch: true,
      },
    },
  ])('$label', ({ defs, options }) => {
    const tools = toOpenAIResponseTools(defs as ToolDefinition[], options);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'web_search');
  });

  // Any tool stays a plain function tool when native web search is off, which is
  // also the default for both options.
  it.each([
    {
      label:
        'keeps web_search as function tool when supportsNativeWebSearch is false',
      def: { name: 'web_search', description: 'Search the web' },
      options: { supportsNativeWebSearch: false },
    },
    {
      label: 'defaults supportsNativeWebSearch to false',
      def: { name: 'web_search', description: 'Search the web' },
      options: undefined,
    },
    {
      label: 'defaults supportsFunctionCalling to true',
      def: { name: 'custom_tool', description: 'A custom function tool' },
      options: undefined,
    },
  ])('$label', ({ def, options }) => {
    const defs: ToolDefinition[] = [def];
    // The default cases call with no options argument, exactly as before.
    const tools = options
      ? toOpenAIResponseTools(defs, options)
      : toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, def.name);
  });

  it('filters out function tools when supportsFunctionCalling is false', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write a file',
      },
    ];

    // Deep research models don't support function calling, so both drop out.
    const tools = toOpenAIResponseTools(defs, {
      supportsFunctionCalling: false,
    });
    assert.equal(tools.length, 0);
  });
});

describe('toGoogleTools', () => {
  // NOTE: Native googleSearch is disabled because Google's regular content
  // generation API does NOT support combining googleSearch with functionDeclarations.
  // This is a Live API only feature. All tools are converted to function declarations.

  it('returns empty array for empty input', () => {
    const tools = toGoogleTools([]);
    assert.deepEqual(tools, []);
  });

  // Every tool (including web_search) becomes a function declaration wrapped in a
  // single Tool object; native googleSearch is never emitted.
  it.each([
    {
      label: 'converts function declarations to single tool object',
      defs: [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      names: ['read_file'],
    },
    {
      label:
        'converts web_search to function declaration (native googleSearch disabled)',
      defs: [{ name: 'web_search', description: 'Search the web' }],
      names: ['web_search'],
    },
    {
      label: 'converts all tools to function declarations',
      defs: [
        { name: 'web_search', description: 'Search the web' },
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      ],
      names: ['web_search', 'read_file', 'write_file'],
    },
  ])('$label', ({ defs, names }) => {
    const tools = toGoogleTools(defs as ToolDefinition[]);
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;
    assert.equal(tool.googleSearch, undefined);
    assert.ok(tool.functionDeclarations);
    assert.deepEqual(
      tool.functionDeclarations?.map((fd) => fd.name),
      names,
    );
  });

  it('flattens top-level discriminated unions into a single object schema', () => {
    // Gemini rejects function parameter schemas whose root is oneOf/anyOf/allOf
    // (HTTP 400: schema must have type 'object' and not contain 'oneOf'/'anyOf'/'allOf').
    // Discriminated unions like the inquiry tool must flatten to a single object.
    const defs: ToolDefinition[] = [
      {
        name: 'inquiry',
        description: 'Ask, read, or list inquiry threads',
        zodSchema: z.discriminatedUnion('command', [
          z.object({
            command: z.literal('ask'),
            question: z.string(),
            thread_id: z.string().nullish(),
          }),
          z.object({
            command: z.literal('read'),
            thread_id: z.string(),
          }),
          z.object({
            command: z.literal('list'),
            status: z.enum(['open', 'answered']).default('open'),
          }),
        ]),
      },
    ];

    const tools = toGoogleTools(defs);
    const tool = tools[0] as GeminiTool;
    const params = tool.functionDeclarations?.[0]
      .parametersJsonSchema as Record<string, unknown>;

    assert.equal(params.type, 'object');
    assert.equal(params.oneOf, undefined);
    assert.equal(params.anyOf, undefined);
    assert.equal(params.allOf, undefined);

    const properties = params.properties as Record<
      string,
      Record<string, unknown>
    >;
    // Discriminator collapses literal branches into an enum.
    assert.deepEqual(properties.command.enum, ['ask', 'read', 'list']);
    assert.equal(properties.command.type, 'string');
    // Branch-specific props are merged in.
    assert.ok(properties.question);
    assert.ok(properties.thread_id);
    assert.ok(properties.status);
    // Only command is required by every branch.
    assert.deepEqual(params.required, ['command']);
  });
});

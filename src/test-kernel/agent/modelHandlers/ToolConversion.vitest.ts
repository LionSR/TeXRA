import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  toAnthropicTools,
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

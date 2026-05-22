import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  toAnthropicTools,
  toOpenAITools,
  toOpenAIResponseTools,
} from '@agent/modelHandlers/toolConversion';
import type { ToolDefinition } from '@model';
import { BashTool } from '@tools/bash';
import { EditFileTool } from '@tools/EditTool';
import { GlobTool } from '@tools/glob';
import { GrepTool } from '@tools/grep';
import { LsTool } from '@tools/ls';
import { ReadFileTool } from '@tools/ReadTool';
import { WriteFileTool } from '@tools/WriteTool';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { FunctionTool } from 'openai/resources/responses/responses';

type OpenAIFunctionTool = Extract<ChatCompletionTool, { type: 'function' }>;

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
      new LsTool().definition,
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

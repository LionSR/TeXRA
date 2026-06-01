import { beforeEach, describe, expect, it } from 'vitest';

import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { resolveToolUseTools } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import {
  __resetToolInjectionRegistry,
  registerToolInjection,
} from '@agent/runtime/toolInjection';
import type { ToolDefinition } from '@model';
import type { ToolResult } from '@tools/result';

const logger = { warn: () => {} };

function testTool(name: string): ITool {
  return {
    definition: { name },
    call: async (): Promise<ToolResult> => ({
      summary: `${name} called`,
      output: '',
    }),
  };
}

function registryFor(names: readonly string[]): MapToolRegistry {
  return new MapToolRegistry(
    Object.fromEntries(names.map((name) => [name, testTool(name)])),
  );
}

function toolDefs(names: readonly string[]): ToolDefinition[] {
  return names.map((name) => ({ name }));
}

describe('tool-use tool resolution', () => {
  beforeEach(() => {
    __resetToolInjectionRegistry();
  });

  it('filters approval-gated tools when approval prompts are unavailable', async () => {
    const registry = registryFor([
      'apply_path',
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'plan',
      'send_to_terminal',
      'update_config',
      'wolfram',
      'write_file',
    ]);

    const { tools, delegationTrimmed } = await resolveToolUseTools(
      toolDefs([
        'apply_path',
        'ask_user_question',
        'bash',
        'delegate_agent',
        'grep',
        'plan',
        'send_to_terminal',
        'update_config',
        'wolfram',
        'write_file',
      ]),
      registry,
      logger,
      {
        approvalPromptsUnavailable: true,
        delegationBlocked: false,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual(['grep', 'wolfram']);
    expect(delegationTrimmed).toBe(false);
  });

  it('keeps approval-gated tools when approval prompts are available', async () => {
    const registry = registryFor([
      'apply_path',
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'plan',
      'update_config',
    ]);

    const { tools } = await resolveToolUseTools(
      toolDefs([
        'apply_path',
        'ask_user_question',
        'bash',
        'delegate_agent',
        'grep',
        'plan',
        'update_config',
      ]),
      registry,
      logger,
      {
        approvalPromptsUnavailable: false,
        delegationBlocked: false,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      'apply_path',
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'plan',
      'update_config',
    ]);
  });

  it('still reports delegation tools trimmed by delegation depth separately', async () => {
    const registry = registryFor(['delegate_agent', 'grep']);

    const { tools, delegationTrimmed } = await resolveToolUseTools(
      toolDefs(['delegate_agent', 'grep']),
      registry,
      logger,
      {
        approvalPromptsUnavailable: false,
        delegationBlocked: true,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual(['grep']);
    expect(delegationTrimmed).toBe(true);
  });

  it('keeps delegation trimming when approval filtering is also active', async () => {
    const registry = registryFor(['bash', 'delegate_agent', 'grep']);

    const { tools, delegationTrimmed } = await resolveToolUseTools(
      toolDefs(['bash', 'delegate_agent', 'grep']),
      registry,
      logger,
      {
        approvalPromptsUnavailable: true,
        delegationBlocked: true,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual(['grep']);
    expect(delegationTrimmed).toBe(true);
  });

  it('also trims injected delegation tools by delegation depth', async () => {
    const registry = registryFor(['delegate_agent', 'grep']);
    registerToolInjection({
      toolName: 'delegate_agent',
      shouldInject: () => true,
    });

    const { tools, delegationTrimmed } = await resolveToolUseTools(
      toolDefs(['grep']),
      registry,
      logger,
      {
        approvalPromptsUnavailable: false,
        delegationBlocked: true,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual(['grep']);
    expect(delegationTrimmed).toBe(true);
  });

  it('filters injected approval-gated tools when approval prompts are unavailable', async () => {
    const registry = registryFor(['grep', 'update_config']);
    registerToolInjection({
      toolName: 'update_config',
      shouldInject: () => true,
    });

    const { tools, delegationTrimmed } = await resolveToolUseTools(
      toolDefs(['grep']),
      registry,
      logger,
      {
        approvalPromptsUnavailable: true,
        delegationBlocked: false,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual(['grep']);
    expect(delegationTrimmed).toBe(false);
  });
});

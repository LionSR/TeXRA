import { beforeEach, describe, expect, it } from 'vitest';

import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import type { ToolDefinition } from '@model';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';
import {
  DIAGNOSTICS_ADD_RUNTIME_CAPABILITY,
  DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
} from '@tools/diagnosticsRuntimeCapabilities';
import { getDefaultToolRegistry } from '@tools/registry';

const logger = { warn: () => {} };

function toolDefs(names: readonly string[]): ToolDefinition[] {
  return names.map((name) => ({ name }));
}

describe('tool-use tool resolution', () => {
  let toolInjections: ToolInjectionRegistry;

  beforeEach(() => {
    toolInjections = new ToolInjectionRegistry();
  });

  it('filters approval-gated tools when approval prompts are unavailable', async () => {
    const names = [
      'apply_path',
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'inquiry',
      'plan',
      'send_to_terminal',
      'update_config',
      'wolfram',
      'write_file',
    ];
    const registry = getDefaultToolRegistry();

    const { tools } = await resolveAgentTools({
      tools: toolDefs(names),
      registry,
      logger,
      toolInjections,
      approvalPromptsUnavailable: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(['grep']);
  });

  it('keeps approval-gated tools when approval prompts are available', async () => {
    const names = [
      'apply_path',
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'inquiry',
      'plan',
      'update_config',
    ];
    const registry = getDefaultToolRegistry();

    const { tools } = await resolveAgentTools({
      tools: toolDefs(names),
      registry,
      logger,
      toolInjections,
      approvalPromptsUnavailable: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'apply_path',
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'inquiry',
      'plan',
      'update_config',
    ]);
  });

  it('filters runtime-unavailable tools without hiding other approval-gated tools', async () => {
    const names = [
      'ask_user_question',
      'bash',
      'grep',
      'inquiry',
      'write_file',
    ];
    const registry = getDefaultToolRegistry();

    const { tools } = await resolveAgentTools({
      tools: toolDefs(names),
      registry,
      logger,
      toolInjections,
      approvalPromptsUnavailable: false,
      runtimeUnavailableTools: ['inquiry'],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'ask_user_question',
      'bash',
      'grep',
      'write_file',
    ]);
  });

  it('narrows diagnostics to read-only commands when add is host-unavailable', async () => {
    const diagnostics = new DiagnosticsTool();
    const registry = new MapToolRegistry({ diagnostics });

    const { tools } = await resolveAgentTools({
      tools: [diagnostics.definition],
      registry,
      logger,
      toolInjections,
      runtimeUnavailableTools: [DIAGNOSTICS_ADD_RUNTIME_CAPABILITY],
      approvalPromptsUnavailable: false,
    });

    const [tool] = tools;
    expect(tool?.name).toBe('diagnostics');
    expect(
      tool?.zodSchema?.safeParse({ command: 'list', path: 'paper.tex' })
        .success,
    ).toBe(true);
    expect(
      tool?.zodSchema?.safeParse({
        command: 'add',
        path: 'paper.tex',
        line: 1,
        message: 'tighten this claim',
        severity: 3,
        confidence: 4,
      }).success,
    ).toBe(false);
  });

  it('omits diagnostics when read support is host-unavailable', async () => {
    const diagnostics = new DiagnosticsTool();
    const registry = new MapToolRegistry({ diagnostics });

    const { tools } = await resolveAgentTools({
      tools: [diagnostics.definition],
      registry,
      logger,
      toolInjections,
      runtimeUnavailableTools: [DIAGNOSTICS_READ_RUNTIME_CAPABILITY],
      approvalPromptsUnavailable: false,
    });

    expect(tools).toEqual([]);
  });

  it('filters injected approval-gated tools when approval prompts are unavailable', async () => {
    const registry = getDefaultToolRegistry();
    toolInjections.register({
      toolName: 'update_config',
      shouldInject: () => true,
    });

    const { tools } = await resolveAgentTools({
      tools: toolDefs(['grep']),
      registry,
      logger,
      toolInjections,
      approvalPromptsUnavailable: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(['grep']);
  });
});

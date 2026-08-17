import { beforeEach, describe, expect, it } from 'vitest';

import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import {
  resolveAgentTools,
  type ResolvedAgentTools,
} from '@agent/runtime/agentToolResolution';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import type { ToolDefinition } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';
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

  async function resolveNames(
    names: readonly string[],
    options: {
      approvalPromptsUnavailable: boolean;
      runtimeUnavailableTools?: readonly string[];
    },
  ): Promise<string[]> {
    const { tools } = await resolveAgentTools({
      tools: toolDefs(names),
      registry: getDefaultToolRegistry(),
      logger,
      toolInjections,
      ...options,
    });
    return tools.map((tool) => tool.name);
  }

  async function resolveDiagnostics(
    runtimeUnavailableTools: readonly string[],
  ): Promise<ResolvedAgentTools> {
    const diagnostics = new DiagnosticsTool();
    const registry = new MapToolRegistry({ diagnostics });
    return resolveAgentTools({
      tools: [diagnostics.definition],
      registry,
      logger,
      toolInjections,
      runtimeUnavailableTools,
      approvalPromptsUnavailable: false,
    });
  }

  it('filters approval-gated tools when approval prompts are unavailable', async () => {
    const names = [
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

    await expect(
      resolveNames(names, { approvalPromptsUnavailable: true }),
    ).resolves.toEqual(['grep']);
  });

  it('keeps approval-gated tools when approval prompts are available', async () => {
    const names = [
      'ask_user_question',
      'bash',
      'delegate_agent',
      'grep',
      'inquiry',
      'plan',
      'update_config',
    ];

    await expect(
      resolveNames(names, { approvalPromptsUnavailable: false }),
    ).resolves.toEqual(names);
  });

  it('filters runtime-unavailable tools without hiding other approval-gated tools', async () => {
    await expect(
      resolveNames(
        ['ask_user_question', 'bash', 'grep', 'inquiry', 'write_file'],
        {
          approvalPromptsUnavailable: false,
          runtimeUnavailableTools: ['inquiry'],
        },
      ),
    ).resolves.toEqual(['ask_user_question', 'bash', 'grep', 'write_file']);
  });

  it('omits diagnostics when read support is host-unavailable', async () => {
    const { tools } = await resolveDiagnostics(['diagnostics']);

    expect(tools).toEqual([]);
  });

  it('drops the workflow script tool when its dashboard switch is disabled', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.DISABLED_TOOLS]: ['workflow-script'] },
    });
    try {
      await expect(
        resolveNames(['bash', 'delegate_multi_agents'], {
          approvalPromptsUnavailable: false,
        }),
      ).resolves.toEqual(['bash']);
    } finally {
      await installPlatform();
    }
  });

  it('filters injected approval-gated tools when approval prompts are unavailable', async () => {
    toolInjections.register({
      toolName: 'update_config',
      shouldInject: () => true,
    });

    await expect(
      resolveNames(['grep'], { approvalPromptsUnavailable: true }),
    ).resolves.toEqual(['grep']);
  });
});

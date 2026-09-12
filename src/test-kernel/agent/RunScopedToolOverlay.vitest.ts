import { describe, expect, it, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import { AgentToolUseSettingSchema } from '@agent/core/definition/AgentDataclass';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { hostStores, setupPlatform } from '@test/support/setupPlatform';

function tool(name: string): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    call: vi.fn(),
  };
}

function approvalGatedTool(name: string): ITool {
  return { ...tool(name), requiresApproval: true };
}

describe('run-scoped tool resolution', () => {
  setupPlatform({ workspacePath: process.cwd() });

  it('filters approval-gated and runtime-unavailable declared tools', async () => {
    // The run's tool policy carries both gates; `AgentRun` hands them to the
    // resolver when it builds the model-facing list.
    const resolved = await resolveAgentTools({
      tools: AgentToolUseSettingSchema.parse({
        tools: [
          { name: 'bash' },
          { name: 'grep' },
          { name: 'inquiry' },
          { name: 'write_file' },
          { name: 'wolfram' },
        ],
      }).tools,
      registry: new MapToolRegistry({
        bash: approvalGatedTool('bash'),
        grep: tool('grep'),
        inquiry: approvalGatedTool('inquiry'),
        write_file: approvalGatedTool('write_file'),
        wolfram: approvalGatedTool('wolfram'),
      }),
      logger: noopTrace,
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['inquiry'],
      // No conditional injections: this pins the declared-tool gates alone.
      toolInjections: new ToolInjectionRegistry(),
      stores: hostStores(),
    });

    expect(resolved.map(({ name }) => name)).toEqual(['grep']);
  });
});

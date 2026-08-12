// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tool under test
import { ClaudeAgentTool } from '@tools/claudeAgent';

describe('ClaudeAgentTool schema', () => {
  it('recommends current Claude Code models in the model field', () => {
    const parameters = new ClaudeAgentTool().definition.parameters as {
      properties?: { model?: { description?: string } };
    };
    const modelDescription = parameters.properties?.model?.description ?? '';

    expect(modelDescription).toContain('claude-sonnet-5');
    expect(modelDescription).toContain('claude-fable-5');
    expect(modelDescription).toContain('claude-opus-5');
    expect(modelDescription).not.toContain('claude-opus-4-8');
  });

  it('requires a source session when session forking is requested', async () => {
    const result = await new ClaudeAgentTool().call({
      prompt: 'branch this conversation',
      fork_session: true,
    });

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('fork_session requires session_id'),
    });
  });
});

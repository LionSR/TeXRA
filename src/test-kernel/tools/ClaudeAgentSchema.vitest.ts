// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - tool under test
import { convertToolSchema } from '@agent/modelHandlers/toolConversion';
import { ClaudeAgentTool } from '@tools/claudeAgent';

describe('ClaudeAgentTool schema', () => {
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

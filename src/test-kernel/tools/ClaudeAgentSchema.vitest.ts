// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { ClaudeAgentTool } from '@tools/claudeAgent';

describe('ClaudeAgentTool schema', () => {
  it('requires a source session when session forking is requested', () => {
    const schema = new ClaudeAgentTool().definition.zodSchema!;
    const result = schema.safeParse({
      prompt: 'branch this conversation',
      fork_session: true,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.message).toContain(
        'fork_session requires session_id',
      );
  });
});

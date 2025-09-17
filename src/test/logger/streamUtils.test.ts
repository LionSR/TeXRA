// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { getStreamTabId } from '@/logger/streamUtils';
import { AgentType } from '@agent/core/AgentDataclass';

describe('getStreamTabId', () => {
  it('builds workflow identifiers using input file name', () => {
    const id = getStreamTabId('polish', 'sonnet', '/tmp/paper.tex');
    assert.equal(id, 'polish@sonnet: paper.tex');
  });

  it('appends multiple suffix for workflow streams with many outputs', () => {
    const id = getStreamTabId('polish', 'sonnet', '/tmp/paper.tex', [
      'out1',
      'out2',
    ]);
    assert.equal(id, 'polish_multiple@sonnet: paper.tex');
  });

  it('avoids duplicating the multiple suffix when already present', () => {
    const id = getStreamTabId('polish_multiple', 'sonnet', '/tmp/paper.tex', [
      'out1',
      'out2',
    ]);
    assert.equal(id, 'polish_multiple@sonnet: paper.tex');
  });

  it('uses execution id prefix for tool use streams', () => {
    const executionId = '12345678-9abc-def0-1234-56789abcdef0';
    const id = getStreamTabId('diagnostics', 'gpt4', '', undefined, {
      agentType: AgentType.ToolUse,
      executionId,
    });
    assert.equal(id, 'diagnostics@gpt4#12345678');
  });
});

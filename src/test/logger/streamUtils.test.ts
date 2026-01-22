// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { getStreamTabId } from '@/logger/streamUtils';

describe('getStreamTabId', () => {
  it('builds workflow identifiers using workspace-relative file path', () => {
    const id = getStreamTabId('polish', 'sonnet', 'chapters/paper.tex');
    assert.equal(id, 'polish@sonnet: chapters/paper.tex');
  });

  it('appends multiple suffix for workflow streams with many outputs', () => {
    const id = getStreamTabId('polish', 'sonnet', 'chapters/paper.tex', {
      useMultipleOutputs: true,
    });
    assert.equal(id, 'polish_multiple@sonnet: chapters/paper.tex');
  });

  it('avoids duplicating the multiple suffix when already present', () => {
    const id = getStreamTabId(
      'polish_multiple',
      'sonnet',
      'chapters/paper.tex',
      {
        useMultipleOutputs: true,
      },
    );
    assert.equal(id, 'polish_multiple@sonnet: chapters/paper.tex');
  });

  it('distinguishes files with same name in different directories', () => {
    const id1 = getStreamTabId('polish', 'sonnet', 'project1/paper.tex');
    const id2 = getStreamTabId('polish', 'sonnet', 'project2/paper.tex');
    assert.notEqual(id1, id2);
    assert.equal(id1, 'polish@sonnet: project1/paper.tex');
    assert.equal(id2, 'polish@sonnet: project2/paper.tex');
  });

  it('normalizes Windows backslashes to forward slashes', () => {
    const id = getStreamTabId('polish', 'sonnet', 'C:\\Users\\test\\paper.tex');
    assert.equal(id, 'polish@sonnet: C:/Users/test/paper.tex');
  });

  it('uses execution id prefix for tool use streams', () => {
    const executionId = '12345678-9abc-def0-1234-56789abcdef0';
    const id = getStreamTabId('diagnostics', 'gpt4', '', {
      agentCategory: AgentCategory.ToolUse,
      executionId,
    });
    assert.equal(id, 'diagnostics@gpt4#12345678');
  });
});

// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { AgentCategory } from '@agent/core/AgentDataclass';
import { getStreamTabId } from '@/logger/streamUtils';

describe('getStreamTabId', () => {
  const EXEC_ID = 'abcdef012345' as const;

  it('builds workflow identifiers using executionId and workspace-relative file path', () => {
    const id = getStreamTabId('polish', 'sonnet', 'chapters/paper.tex', {
      executionId: EXEC_ID,
    });
    assert.equal(id, `polish@sonnet#${EXEC_ID}: chapters/paper.tex`);
  });

  it('appends multiple suffix for workflow streams with many outputs', () => {
    const id = getStreamTabId('polish', 'sonnet', 'chapters/paper.tex', {
      executionId: EXEC_ID,
      useMultipleOutputs: true,
    });
    assert.equal(id, `polish_multiple@sonnet#${EXEC_ID}: chapters/paper.tex`);
  });

  it('avoids duplicating the multiple suffix when already present', () => {
    const id = getStreamTabId(
      'polish_multiple',
      'sonnet',
      'chapters/paper.tex',
      {
        executionId: EXEC_ID,
        useMultipleOutputs: true,
      },
    );
    assert.equal(id, `polish_multiple@sonnet#${EXEC_ID}: chapters/paper.tex`);
  });

  it('gives each execution a unique tab id', () => {
    const id1 = getStreamTabId('polish', 'sonnet', 'paper.tex', {
      executionId: 'aaaaaaaaaaaa',
    });
    const id2 = getStreamTabId('polish', 'sonnet', 'paper.tex', {
      executionId: 'bbbbbbbbbbbb',
    });
    assert.notEqual(id1, id2);
  });

  it('normalizes Windows backslashes to forward slashes', () => {
    const id = getStreamTabId('polish', 'sonnet', 'C:\\Users\\test\\paper.tex', {
      executionId: EXEC_ID,
    });
    assert.equal(id, `polish@sonnet#${EXEC_ID}: C:/Users/test/paper.tex`);
  });

  it('uses execution id for tool use streams without file suffix', () => {
    const id = getStreamTabId('diagnostics', 'gpt4', '', {
      agentCategory: AgentCategory.ToolUse,
      executionId: '12345678abcd',
    });
    assert.equal(id, 'diagnostics@gpt4#12345678abcd');
  });
});

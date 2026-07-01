import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { entriesToOptionData } from '@agent/index/agentOptionsBuilder';
import type { AgentEntry } from '@agent/index/agentEntry';

describe('agent option labels', () => {
  function toolUseAgent(
    name: string,
    source: AgentEntry['source'] = 'remote',
    description?: string,
  ): AgentEntry {
    return {
      name,
      source,
      path: '',
      category: AgentCategory.ToolUse,
      description,
      tools: [],
    };
  }

  it.each(['review', 'codeReviewer', 'paper-reviewer'])(
    'uses the authored agent name %j as the option label',
    (name) => {
      const [option] = entriesToOptionData([toolUseAgent(name)]);

      expect(option?.label).toBe(name);
    },
  );

  it('does not carry descriptions into picker options', () => {
    const [option] = entriesToOptionData([
      toolUseAgent('review', 'remote', 'Verifies mathematical correctness.'),
    ]);

    expect(option?.value).toBe('remote:review');
    expect(option?.label).toBe('review');
    expect(option).not.toHaveProperty('description');
  });

  it('does not invent labels to distinguish different authored names', () => {
    const options = entriesToOptionData([
      toolUseAgent('review'),
      toolUseAgent('reviewer'),
    ]);

    expect(options.map((option) => option.label)).toEqual([
      'review',
      'reviewer',
    ]);
  });

  it('leaves custom agent identifiers exactly as authored', () => {
    const [option] = entriesToOptionData([
      {
        name: 'myPaperHelper',
        source: 'custom',
        path: '/agents/myPaperHelper.yaml',
        category: AgentCategory.ToolUse,
        tools: [],
      },
    ]);

    expect(option?.value).toBe('custom:myPaperHelper');
    expect(option?.label).toBe('myPaperHelper');
  });
});

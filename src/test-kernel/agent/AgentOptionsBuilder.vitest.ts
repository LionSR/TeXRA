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

  it('uses authored agent names for option labels', () => {
    const options = entriesToOptionData([toolUseAgent('review')]);

    expect(options.map((option) => option.label)).toEqual(['review']);
  });

  it('keeps title-case names exactly as authored', () => {
    const [option] = entriesToOptionData([toolUseAgent('Code Reviewer')]);

    expect(option?.label).toBe('Code Reviewer');
  });

  it('removes descriptive dash suffixes from picker labels', () => {
    const [option] = entriesToOptionData([
      toolUseAgent('Review \u2014 verify math & consistency'),
    ]);

    expect(option?.value).toBe(
      'remote:Review \u2014 verify math & consistency',
    );
    expect(option?.label).toBe('Review');
  });

  it('removes ASCII detail suffixes from picker labels', () => {
    const [option] = entriesToOptionData([
      toolUseAgent('Engineer --- software team lead'),
    ]);

    expect(option?.label).toBe('Engineer');
  });

  it('preserves ordinary hyphenated agent labels', () => {
    const [option] = entriesToOptionData([toolUseAgent('paper-reviewer')]);

    expect(option?.label).toBe('paper-reviewer');
  });

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

  it('leaves custom agent labels exactly as authored', () => {
    const [option] = entriesToOptionData([
      {
        name: 'My Paper Helper',
        source: 'custom',
        path: '/agents/My Paper Helper.yaml',
        category: AgentCategory.ToolUse,
        tools: [],
      },
    ]);

    expect(option?.value).toBe('custom:My Paper Helper');
    expect(option?.label).toBe('My Paper Helper');
  });
});

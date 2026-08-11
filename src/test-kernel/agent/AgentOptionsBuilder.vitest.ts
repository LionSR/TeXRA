import { describe, expect, it } from 'vitest';

import { entriesToOptionData } from '@agent/index/agentRegistry';
import type { AgentEntry } from '@agent/index/agentEntry';
import { AgentCategory } from '@shared/schemas';

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
      const options = entriesToOptionData([toolUseAgent(name)]);
      const [option] = options;

      expect(options).toHaveLength(1);
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

  it('marks inline agents with their launcher provenance', () => {
    const [option] = entriesToOptionData([
      toolUseAgent('embeddedHelper', 'inline'),
    ]);

    expect(option).toMatchObject({
      value: 'inline:embeddedHelper',
      label: 'embeddedHelper',
      isInline: true,
      isCustom: false,
      isRemote: false,
    });
  });
});

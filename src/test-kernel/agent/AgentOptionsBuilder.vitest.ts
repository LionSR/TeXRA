import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { entriesToOptionData } from '@agent/index/agentOptionsBuilder';
import type { AgentEntry } from '@agent/index/agentEntry';

describe('agent option labels', () => {
  function remoteToolUseAgent(name: string, description?: string): AgentEntry {
    return {
      name,
      source: 'remote',
      path: '',
      category: AgentCategory.ToolUse,
      description,
      tools: [],
    };
  }

  it('uses canonical agent ids instead of decorated remote names', () => {
    const options = entriesToOptionData([
      remoteToolUseAgent('Review — verify math & consistency'),
      remoteToolUseAgent('Engineer --- software team lead'),
      remoteToolUseAgent('Lean Orchestrator — coordinates'),
    ]);

    expect(options.map((option) => option.label)).toEqual([
      'review',
      'engineer',
      'leanOrchestrator',
    ]);
  });

  it('does not rewrite plain title-case remote names', () => {
    const [option] = entriesToOptionData([remoteToolUseAgent('Code Reviewer')]);

    expect(option?.label).toBe('Code Reviewer');
  });

  it('keeps resolution values stable while canonicalizing labels', () => {
    const [option] = entriesToOptionData([
      remoteToolUseAgent(
        'Review — verify math & consistency',
        'Verifies mathematical correctness.',
      ),
    ]);

    expect(option?.value).toBe('remote:Review — verify math & consistency');
    expect(option?.label).toBe('review');
    expect(option?.description).toBe('Verifies mathematical correctness.');
  });

  it('keeps duplicate canonical labels unique without showing decorated names', () => {
    const options = entriesToOptionData([
      remoteToolUseAgent('Review — verify math'),
      remoteToolUseAgent('Review — verify consistency'),
    ]);

    expect(options.map((option) => option.label)).toEqual([
      'review1',
      'review2',
    ]);
    expect(options.map((option) => option.value)).toEqual([
      'remote:Review — verify math',
      'remote:Review — verify consistency',
    ]);
  });

  it('does not collide with existing labels when numbering duplicates', () => {
    const options = entriesToOptionData([
      remoteToolUseAgent('Review — verify math'),
      remoteToolUseAgent('Review — verify consistency'),
      remoteToolUseAgent('review1'),
    ]);

    expect(options.map((option) => option.label)).toEqual([
      'review2',
      'review3',
      'review1',
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

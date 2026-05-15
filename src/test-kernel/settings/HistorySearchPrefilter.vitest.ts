import { describe, expect, it } from 'vitest';

import {
  getHistorySearchText,
  getHistorySearchTokens,
  historySearchTextMatches,
} from '@settingsView/frontend/components/history/historySearch';
import type { HistoryItem } from '@shared/schemas';

const workflowHistoryItem: HistoryItem = {
  id: 'execution-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  description: 'Improve memory listing responsiveness near the café example',
  agentConfig: {
    agentCategory: 'workflow',
    agent: 'orchestrator',
    model: 'test-model',
    instruction: 'Summarize the variational argument.',
    inputFile: 'paper/main.tex',
    inputFiles: ['paper/appendix.tex'],
    mediaFiles: ['figures/spectrum.png'],
    contextFiles: ['refs/source.tex', 'notes/context.md'],
    outputFiles: ['build/revised.tex'],
    toolConfig: {
      latexEngine: 'xelatex',
      maxRounds: 2,
    },
  },
};

const minimalWorkflowHistoryItem: HistoryItem = {
  id: 'execution-2',
  timestamp: '2026-01-02T00:00:00.000Z',
  agentConfig: {
    agentCategory: 'workflow',
  },
};

describe('history search prefilter', () => {
  it('matches rendered history fields without requiring DOM construction', () => {
    const searchText = getHistorySearchText(workflowHistoryItem);

    expect(
      historySearchTextMatches(searchText, getHistorySearchTokens('spectrum')),
    ).toBe(true);
    expect(
      historySearchTextMatches(searchText, getHistorySearchTokens('xelatex')),
    ).toBe(true);
    expect(
      historySearchTextMatches(searchText, getHistorySearchTokens('cafe')),
    ).toBe(true);
    expect(
      historySearchTextMatches(searchText, getHistorySearchTokens('absent')),
    ).toBe(false);
  });

  it('does not match workflow labels that are not rendered for an item', () => {
    const searchText = getHistorySearchText(minimalWorkflowHistoryItem);

    expect(
      historySearchTextMatches(searchText, getHistorySearchTokens('mediafile')),
    ).toBe(false);
    expect(
      historySearchTextMatches(searchText, getHistorySearchTokens('not set')),
    ).toBe(true);
  });

  it('keeps multi-word searches broad like mark.js separate word search', () => {
    const searchText = getHistorySearchText(workflowHistoryItem);

    expect(
      historySearchTextMatches(
        searchText,
        getHistorySearchTokens('missing variational'),
      ),
    ).toBe(true);
  });
});

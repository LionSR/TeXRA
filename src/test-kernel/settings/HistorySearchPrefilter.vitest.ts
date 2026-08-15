import { describe, expect, it } from 'vitest';

import {
  getHistorySearchText,
  getHistorySearchTokens,
  historySearchTextMatches,
} from '@settingsView/frontend/components/history/historySearch';
import { HISTORY_RUN_STATUS } from '@shared/schemas';
import type { HistoryItem } from '@shared/schemas';

const workflowHistoryItem: HistoryItem = {
  id: 'execution-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  description: 'Improve memory listing responsiveness near the café example',
  status: HISTORY_RUN_STATUS.RESUMABLE,
  agentConfig: {
    agentCategory: 'workflow',
    agent: 'orchestrator',
    model: 'test-model',
    instruction: 'Summarize the variational argument.',
    inputFiles: ['paper/main.tex', 'paper/appendix.tex'],
    mediaFiles: ['figures/spectrum.png'],
    contextFiles: ['refs/source.tex', 'notes/context.md'],
    outputFiles: ['build/revised.tex'],
    toolConfig: {
      autoExtractFigure: false,
      autoExtractTikzFigure: false,
      attachTeXCount: true,
      attachDiagnostics: true,
      autoCompileInputPdf: false,
    },
  },
};

const minimalWorkflowHistoryItem: HistoryItem = {
  id: 'execution-2',
  timestamp: '2026-01-02T00:00:00.000Z',
  status: HISTORY_RUN_STATUS.UNKNOWN,
  agentConfig: {
    agentCategory: 'workflow',
  },
};

const toolUseHistoryItem: HistoryItem = {
  id: 'execution-3',
  timestamp: '2026-01-03T00:00:00.000Z',
  status: HISTORY_RUN_STATUS.FAILED,
  agentConfig: {
    agentCategory: 'toolUse',
    agent: 'researcher',
    model: 'test-model',
    instruction: 'Check the lemma.',
    editedFiles: ['proofs/lemma.md'],
  },
};

function matches(item: HistoryItem, query: string): boolean {
  return historySearchTextMatches(
    getHistorySearchText(item),
    getHistorySearchTokens(query),
  );
}

describe('history search prefilter', () => {
  it('matches rendered history fields without requiring DOM construction', () => {
    expect(matches(workflowHistoryItem, 'spectrum')).toBe(true);
    expect(matches(workflowHistoryItem, 'diagnostics')).toBe(true);
    expect(matches(workflowHistoryItem, 'cafe')).toBe(true);
    expect(matches(workflowHistoryItem, 'absent')).toBe(false);
  });

  it('matches a run status by its stored value and by its badge text', () => {
    // The search body carries both, so rewording a badge cannot silently drop
    // the status people already type.
    expect(matches(workflowHistoryItem, 'resumable')).toBe(true);
    expect(matches(workflowHistoryItem, 'Resumable')).toBe(true);
    expect(matches(toolUseHistoryItem, 'failed')).toBe(true);
    expect(matches(minimalWorkflowHistoryItem, 'unknown')).toBe(true);
    expect(matches(toolUseHistoryItem, 'resumable')).toBe(false);
  });

  it('does not match workflow labels that are not rendered for an item', () => {
    expect(matches(minimalWorkflowHistoryItem, 'mediafile')).toBe(false);
    expect(matches(minimalWorkflowHistoryItem, 'not set')).toBe(true);
  });

  it('keeps multi-word searches broad like mark.js separate word search', () => {
    expect(matches(workflowHistoryItem, 'missing variational')).toBe(true);
  });

  it('matches edited files rendered for tool-use history items', () => {
    expect(matches(toolUseHistoryItem, 'lemma.md')).toBe(true);
    expect(matches(toolUseHistoryItem, 'more details')).toBe(true);
  });

  it('matches the rendered short-month timestamp text (kept in sync with HistoryItemElement)', () => {
    // HistoryItemElement renders its meta-strip timestamp via
    // formatShortDateTime (@utils/text/stringUtils) — the search index must
    // include that same shaped text, not just the raw ISO timestamp, so a
    // search for what the user actually sees still matches. Midday UTC
    // keeps the rendered month stable across any real-world timezone.
    const midMonthItem: HistoryItem = {
      id: 'execution-4',
      timestamp: '2026-05-15T12:00:00.000Z',
      status: HISTORY_RUN_STATUS.COMPLETED,
      agentConfig: { agentCategory: 'workflow' },
    };
    // Derive the expected month token from the same locale-aware
    // Intl.DateTimeFormat shape rather than hard-coding an English name,
    // so the assertion holds under any process locale.
    const expectedMonth = new Intl.DateTimeFormat(undefined, {
      month: 'short',
    }).format(new Date(midMonthItem.timestamp));
    expect(matches(midMonthItem, expectedMonth)).toBe(true);
    expect(matches(midMonthItem, '2026')).toBe(true);
  });
});

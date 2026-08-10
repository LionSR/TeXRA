import { describe, expect, it } from 'vitest';

import {
  ActiveSkillsPanel,
  activeSkillsPanelRowCount,
} from '@cli/chat/tui/panes/ActiveSkillsPanel';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import {
  ActiveSkillSummarySchema,
  type ActiveSkillSummary,
} from '@shared/schemas';
import { loadInk } from '@test/support/inkTestHarness.ts';

const SKILLS: ActiveSkillSummary[] = [
  {
    name: 'proof-audit',
    description: 'Check proof steps and assumptions.',
    source: 'project',
  },
  {
    name: 'literature-search',
    description: 'Find and compare relevant references.',
    source: 'bundled',
  },
  {
    name: 'writing-review',
    description: 'Review structure and clarity.',
    source: 'user',
  },
  {
    name: 'extra-skill',
    description: 'This item is beyond the row cap.',
    source: 'custom',
  },
];

describe('ActiveSkillsPanel', () => {
  it('stays one line in a narrow terminal', async () => {
    const { ink, React } = await loadInk();
    const output = ink.renderToString(
      React.createElement(ActiveSkillsPanel, {
        columns: 24,
        maxRows: activeSkillsPanelRowCount(SKILLS, 24),
        skills: SKILLS,
      }),
      { columns: 24 },
    );

    expect(output.split('\n')).toHaveLength(1);
    expect(output).toContain('Skills (4):');
    expect(textDisplayWidth(output)).toBeLessThanOrEqual(24);
  });

  it('renders only schema-sanitized text from adversarial summaries', async () => {
    const { ink, React } = await loadInk();
    const skill = ActiveSkillSummarySchema.parse({
      name: 'safe-terminal',
      description:
        '\u001b[31mInspect\u001b[0m C:\\Users\\Jane Doe\\private notes.txt before ./release/key.pem.',
      source: 'project',
    });
    const output = ink.renderToString(
      React.createElement(ActiveSkillsPanel, {
        columns: 80,
        maxRows: 2,
        skills: [skill],
      }),
      { columns: 80 },
    );

    expect(output).toContain('Details available on activation.');
    expect(output).not.toContain('Users');
    expect(output).not.toContain('private');
    expect(output).not.toContain('release');
    expect(output).not.toContain('\u001b');
  });

  it('caps normal layouts and hides empty catalogs', async () => {
    const { ink, React } = await loadInk();
    const output = ink.renderToString(
      React.createElement(ActiveSkillsPanel, {
        columns: 80,
        maxRows: activeSkillsPanelRowCount(SKILLS, 80),
        skills: SKILLS,
      }),
      { columns: 80 },
    );

    expect(output.split('\n').length).toBeLessThanOrEqual(3);
    expect(output).toContain('(+2 more)');
    expect(activeSkillsPanelRowCount([], 80)).toBe(0);
    expect(
      ActiveSkillsPanel({ columns: 80, maxRows: 0, skills: SKILLS }),
    ).toBeNull();
  });
});

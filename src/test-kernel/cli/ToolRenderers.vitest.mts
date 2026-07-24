// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import {
  toolHeaderPreviewBudget,
  toolUseDisplayLines,
  toolUseStyledLines,
} from '@cli/chat/tui/panes/toolRenderers';
import { TOOL_USE_STATUS, type NormalizedToolUse } from '@shared/schemas';

// Local imports - CLI TUI rendering

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<NormalizedToolUse> = {},
): NormalizedToolUse {
  return {
    toolName,
    errorText: '',
    outputText: '',
    userInstructionText: '',
    input,
    isError: false,
    isUserFeedback: false,
    headerSummary: '',
    status: TOOL_USE_STATUS.COMPLETED,
    ...overrides,
  };
}

describe('CLI tool display lines', () => {
  it('carries semantic styles in the display model', () => {
    const entry = toolUse(
      'bash',
      { command: 'npm test' },
      { outputText: 'passed' },
    );

    expect(toolUseStyledLines(entry)).toEqual([
      {
        kind: 'row',
        spans: [
          { color: 'green', dim: false, text: '● ' },
          { bold: true, text: 'bash' },
          { color: 'cyan', dim: false, text: ' (npm test)' },
        ],
      },
      {
        kind: 'row',
        spans: [{ dim: true, text: '⎿ ' }, { text: 'passed' }],
      },
    ]);
    expect(Object.isFrozen(toolUseStyledLines(entry)[0])).toBe(true);
    const firstLine = toolUseStyledLines(entry)[0];
    if (firstLine?.kind !== 'row') throw new Error('expected a row');
    expect(Object.isFrozen(firstLine.spans)).toBe(true);
    expect(firstLine.spans.every(Object.isFrozen)).toBe(true);
  });

  it('counts wrapped patch rows at the rich terminal width', () => {
    const entry = toolUse('Edit', {
      path: 'paper.tex',
      old_string: 'short\n',
      new_string: `${'a long replacement '.repeat(8)}\n`,
    });

    expect(toolUseDisplayLines(entry, { width: 24 }).length).toBeGreaterThan(
      toolUseDisplayLines(entry).length,
    );
  });

  it('previews a codex call by its prompt, not raw JSON, matching the progress view', () => {
    const entry = toolUse('codex', { prompt: 'Summarize this proof.' });

    expect(toolUseDisplayLines(entry)).toEqual([
      '● codex (Summarize this proof.)',
    ]);
  });

  it('registers edit patch rendering before the universal fallback', () => {
    const entry = toolUse('Edit', {
      path: 'paper.tex',
      old_string: 'We use a CNN.\n',
      new_string: 'We use a transformer.\n',
    });

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● Edit (paper.tex)",
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -We use a CNN.",
        "  +We use a transformer.",
      ]
    `);
  });

  it('keeps bash semantics ahead of generic MCP presentation', () => {
    const entry = toolUse(
      'mcp:terminal:bash',
      { command: 'false' },
      {
        errorText: 'Command failed (exit 7)',
        isError: true,
        exitCode: 7,
      },
    );

    expect(toolUseDisplayLines(entry)).toEqual([
      '● terminal/bash (false)',
      '⎿ exit 7',
      '⎿ Command failed (exit 7)',
    ]);
    const header = toolUseStyledLines(entry)[0];
    if (header?.kind !== 'row') throw new Error('expected a header row');
    expect(header.spans.at(-1)).toMatchObject({ color: 'cyan' });
  });

  it('renders executions targets with retained subagent labels', () => {
    const entry = toolUse('executions', {
      action: 'wait',
      path: '/executions',
      ids: ['sub-1', 'sub-2'],
    });

    expect(
      toolUseDisplayLines(entry, {
        executionLabels: new Map([
          ['sub-1', 'reviewer'],
          ['sub-2', 'leanSolver'],
        ]),
      }),
    ).toEqual(['● executions (wait: reviewer, leanSolver)']);
  });

  it('shows the action and path for a background process, matching the progress view', () => {
    const entry = toolUse('executions', {
      action: 'view',
      path: '/executions/process-1',
    });

    expect(
      toolUseDisplayLines(entry, {
        executionLabels: new Map([['sub-1', 'reviewer']]),
      }),
    ).toEqual(['● executions (view /executions/process-1)']);
  });

  it('keeps the resource path when labeling an executions target', () => {
    const entry = toolUse('executions', {
      path: '/executions/sub-1/workspace-files/review.md',
    });

    expect(
      toolUseDisplayLines(entry, {
        executionLabels: new Map([['sub-1', 'reviewer']]),
      }),
    ).toEqual(['● executions (view: reviewer/workspace-files/review.md)']);
  });

  it('renders TeXRA edit_file calls through the native diff row', () => {
    const entry = toolUse('edit_file', {
      path: 'paper.tex',
      old_str: 'We use a CNN.\n',
      new_str: 'We use a transformer.\n',
    });

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● edit_file (paper.tex)",
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -We use a CNN.",
        "  +We use a transformer.",
      ]
    `);
  });

  it('renders bash failures with command preview, output, and explicit exit line', () => {
    const entry = toolUse(
      'bash',
      { command: 'npm run lint' },
      {
        errorText: 'Command failed (exit 2)',
        headerSummary: 'npm run lint',
        isError: true,
        outputText: 'checked 12 files\n2 problems found',
        exitCode: 2,
      },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (npm run lint)",
        "⎿ checked 12 files",
        "  2 problems found",
        "⎿ exit 2",
        "⎿ Command failed (exit 2)",
      ]
    `);
  });

  it('renders bash approval rejections once when output and error match', () => {
    const message = "User rejected command: printf 'approval-reject-live\\n'";
    const entry = toolUse(
      'bash',
      { command: "printf 'approval-reject-live\\n'" },
      {
        errorText: message,
        headerSummary: "printf 'approval-reject-live\\n'",
        isError: true,
        outputText: message,
      },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (printf 'approval-reject-live\\n')",
        "⎿ User rejected command: printf 'approval-reject-live\\n'",
      ]
    `);
  });

  it('keeps long duplicate error output when printing full output', () => {
    const message = `User rejected command: ${'diagnostic detail '.repeat(30)}`;
    const entry = toolUse(
      'bash',
      { command: 'run-diagnostic' },
      {
        errorText: message,
        headerSummary: 'run-diagnostic',
        isError: true,
        outputText: message,
      },
    );

    const lines = toolUseDisplayLines(entry, { elide: false });

    expect(lines[1]).toBe(`⎿ ${message}`);
    expect(lines[2]).toContain('User rejected command: diagnostic detail');
    expect(lines[2].length).toBeLessThan(lines[1].length);
  });

  it('elides long bash output to a head+tail slice with a line marker', () => {
    const entry = toolUse(
      'bash',
      { command: 'seq 20' },
      {
        headerSummary: 'seq 20',
        outputText: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
          '\n',
        ),
      },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (seq 20)",
        "⎿ line 1",
        "  line 2",
        "  line 3",
        "  line 4",
        "  line 5",
        "  line 6",
        "  … +11 lines (ctrl + t to print full output)",
        "  line 18",
        "  line 19",
        "  line 20",
      ]
    `);
  });

  it('caps a single pathologically long output line instead of rendering it whole', () => {
    const hugeLine = 'x'.repeat(50_000);
    const entry = toolUse(
      'bash',
      { command: "rg -n --fixed-strings 'approved-plan' ~/.nvm" },
      {
        headerSummary: "rg -n --fixed-strings 'approved-plan' ~/.nvm",
        outputText: hugeLine,
      },
    );

    const lines = toolUseDisplayLines(entry);
    expect(lines).toHaveLength(2);
    expect(lines[1].length).toBeLessThan(2010);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('keeps short bash output whole when elision would not reduce height', () => {
    const entry = toolUse(
      'bash',
      { command: 'seq 10' },
      {
        headerSummary: 'seq 10',
        outputText: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
          '\n',
        ),
      },
    );

    const lines = toolUseDisplayLines(entry);
    expect(lines).toHaveLength(11);
    expect(lines.some((line) => line.includes('ctrl + t'))).toBe(false);
    expect(lines.at(-1)).toBe('  line 10');
  });

  it('shows the full bash output when elision is disabled for printing', () => {
    const entry = toolUse(
      'bash',
      { command: 'seq 12' },
      {
        headerSummary: 'seq 12',
        outputText: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
          '\n',
        ),
      },
    );

    const full = toolUseDisplayLines(entry, { elide: false });
    expect(full).toHaveLength(13); // header + 12 output lines, no marker
    expect(full.some((line) => line.includes('ctrl + t'))).toBe(false);
    expect(full.at(-1)).toBe('  line 12');
  });

  it('preserves MCP server names as server/tool labels', () => {
    const entry = toolUse(
      'mcp:slack:send',
      { channel: '#drafts', text: 'done' },
      { outputText: 'sent' },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● slack/send ({"channel":"#drafts","text":"done"})",
        "⎿ sent",
      ]
    `);
  });

  it('keeps unregistered tools on the universal renderer', () => {
    const entry = toolUse('CustomTool', { path: 'paper.tex' });

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● CustomTool (paper.tex)",
      ]
    `);
  });

  it('keeps read_file rows compact instead of printing file contents', () => {
    const entry = toolUse(
      'read_file',
      { path: 'paper.tex' },
      { outputText: 'Large file contents\nwith many lines' },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● read_file (paper.tex)",
      ]
    `);
  });

  it('sizes live header previews to the terminal width', () => {
    // Wide terminals show more of the command than the historical 80 columns.
    expect(toolHeaderPreviewBudget(200, 'bash')).toBe(191);
    // Narrow terminals truncate to fit one row instead of wrapping.
    expect(toolHeaderPreviewBudget(60, 'bash')).toBe(51);
    // When the name + chrome already eat the row, drop the preview entirely
    // instead of overflowing into a second row.
    expect(toolHeaderPreviewBudget(20, 'a-rather-long-tool-name')).toBe(0);
    // Unknown width falls back to the historical fixed budget.
    expect(toolHeaderPreviewBudget(undefined, 'bash')).toBe(80);
  });
});

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - CLI TUI rendering
import {
  toolHeaderPreviewBudget,
  toolUseDisplayLines,
  toolUseStyledLines,
} from '@cli/chat/tui/panes/toolRenderers';
import { toolDisplaySpanTextProps } from '@cli/chat/tui/panes/ToolUseRow';
import type { ConversationEntry } from '@cli/chat/tui/state/cliState';

// Local imports - shared schemas
import type { NormalizedToolUse } from '@shared/schemas';
import type { ToolRow } from '@shared/transcript';

// Local imports - test support
import { loadInk } from '@test/support/inkTestHarness.ts';
import { toolRowFixture } from '@test/support/transcriptRowFixtures';

function toolUse(
  toolName: string,
  input: unknown,
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  return toolRowFixture(`tool-${toolName}`, { toolName, input, ...overrides });
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

function bashOutput(
  command: string,
  outputText: string,
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  return toolUse(
    'bash',
    { command },
    { headerSummary: command, outputText, ...overrides },
  );
}

async function renderBoundedTool(
  entry: ToolRow,
  maxRows: number,
): Promise<string> {
  const { ink, React } = await loadInk();
  const { BoundedTranscriptEntry } =
    await import('@cli/chat/tui/panes/TranscriptEntry');
  const transcriptEntry: ConversationEntry = {
    finalized: false,
    id: 'bounded-tool',
    role: 'tool',
    text: '',
    row: entry,
    toolUse: entry.toolUse,
  };
  return ink.renderToString(
    React.createElement(BoundedTranscriptEntry, {
      entry: transcriptEntry,
      maxRows,
      width: 80,
    }),
    { columns: 80 },
  );
}

describe('CLI tool display lines', () => {
  it('carries semantic styles in the display model', () => {
    const entry = toolUse(
      'bash',
      { command: 'npm test' },
      { outputText: 'passed' },
    );

    const lines = toolUseStyledLines(entry);
    expect(lines).toEqual([
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
    const firstLine = lines[0];
    if (firstLine?.kind !== 'row') throw new Error('expected a row');
    expect(Object.isFrozen(firstLine)).toBe(true);
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

  it('renders a codex call as typed sections, not raw JSON, matching the progress view', () => {
    const entry = toolUse('codex', {
      prompt: 'Summarize this proof.',
      sandbox_mode: 'read-only',
      thread_id: 'thread-1',
    });

    expect(toolUseDisplayLines(entry)).toEqual([
      '● codex (Summarize this proof.)',
      '⎿ Prompt: Summarize this proof.',
      '⎿ Mode: read-only, follow-up',
    ]);
  });

  it('paints codex patch and todo cards from the shared section vocabulary', () => {
    expect(
      toolUseDisplayLines(
        toolUse('codex_patch', {
          patchStatus: 'applied',
          changes: [
            { path: 'proof.tex', kind: 'update' },
            { path: 'notes.md', kind: 'add' },
          ],
        }),
      ),
    ).toEqual([
      '● Codex Files',
      '⎿ Status: applied',
      '⎿ Files:',
      '    proof.tex (update)',
      '    notes.md (add)',
    ]);

    expect(
      toolUseDisplayLines(
        toolUse('codex_todo', {
          completedCount: 1,
          totalCount: 2,
          items: [
            { text: 'Read the proof', completed: true },
            { text: 'Check lemma 3', completed: false },
          ],
        }),
      ),
    ).toEqual([
      '● Codex Plan',
      '⎿ Progress: 1/2 completed',
      '⎿ Checklist:',
      '    ☑ Read the proof',
      '    □ Check lemma 3',
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
      'mcp:terminal/bash',
      { command: 'false' },
      {
        errorText: 'Command failed (exit 7)',
        isError: true,
        exitCode: 7,
      },
    );

    expect(toolUseDisplayLines(entry)).toEqual([
      '● MCP terminal/bash (false)',
      '⎿ Arguments: command: "false"',
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
    ).toEqual([
      '● executions (wait: reviewer, leanSolver)',
      '⎿ Action: wait (timeout: 300s)',
    ]);
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
    const entry = bashOutput(
      'npm run lint',
      'checked 12 files\n2 problems found',
      {
        errorText: 'Command failed (exit 2)',
        isError: true,
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
    const command = "printf 'approval-reject-live\\n'";
    const message = `User rejected command: ${command}`;
    const entry = bashOutput(command, message, {
      errorText: message,
      isError: true,
    });

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (printf 'approval-reject-live\\n')",
        "⎿ User rejected command: printf 'approval-reject-live\\n'",
      ]
    `);
  });

  it('elides long bash output to a head+tail slice with a line marker', () => {
    const entry = bashOutput('seq 20', numberedLines(20));

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● bash (seq 20)",
        "⎿ line 1",
        "  line 2",
        "  line 3",
        "  line 4",
        "  line 5",
        "  line 6",
        "  … +11 lines (Ctrl-T to view full output)",
        "  line 18",
        "  line 19",
        "  line 20",
      ]
    `);
  });

  it('caps a single pathologically long output line instead of rendering it whole', () => {
    const entry = bashOutput(
      "rg -n --fixed-strings 'approved-plan' ~/.nvm",
      'x'.repeat(50_000),
    );

    const lines = toolUseDisplayLines(entry);
    expect(lines).toHaveLength(2);
    expect(lines[1].length).toBeLessThan(2010);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it.each([
    // Short output stays whole when elision would not reduce height.
    { count: 10, elide: true },
    // Elision disabled for printing shows the full output.
    { count: 12, elide: false },
  ])(
    'keeps bash output whole with no marker (count=$count, elide=$elide)',
    ({ count, elide }) => {
      const entry = bashOutput(`seq ${count}`, numberedLines(count));

      const lines = toolUseDisplayLines(entry, { elide });

      // header + output lines, no elision marker
      expect(lines).toHaveLength(count + 1);
      expect(lines.some((line) => line.includes('ctrl + t'))).toBe(false);
      expect(lines.at(-1)).toBe(`  line ${count}`);
    },
  );

  it('labels MCP calls with their server/tool provenance', () => {
    const entry = toolUse(
      'mcp:slack/send',
      { channel: '#drafts', text: 'done' },
      { outputText: 'sent' },
    );

    expect(toolUseDisplayLines(entry)).toMatchInlineSnapshot(`
      [
        "● MCP slack/send",
        "⎿ Arguments:",
        "  channel: "#drafts"",
        "  text: done",
        "⎿ Result: sent",
      ]
    `);
  });

  it('gives a delegated sub-agent tool the same treatment as the name it wraps', () => {
    const entry = toolUse('claude:Bash', { command: 'npm test' });

    expect(toolUseDisplayLines(entry)).toEqual([
      '● Bash (npm test)',
      '⎿ (no output)',
    ]);
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

describe('ToolUseRow edit patch rendering', () => {
  it('renders MultiEdit edits as patch previews for the target file', () => {
    // The patch block follows the single header row in the display lines.
    const rows = toolUseDisplayLines(
      toolUse('MultiEdit', {
        file_path: 'paper.tex',
        edits: [
          {
            old_string: 'first claim\n',
            new_string: 'revised first claim\n',
          },
          {
            old_string: 'second claim\n',
            new_string: 'revised second claim\n',
          },
        ],
      }),
    ).slice(1);

    expect(rows).toMatchInlineSnapshot(`
      [
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -first claim",
        "  +revised first claim",
        "⎿ paper.tex",
        "  @@ -1,1 +1,1 @@",
        "  -second claim",
        "  +revised second claim",
      ]
    `);
  });

  it('falls back for non-edit tools and failed edits', () => {
    // Bash keeps its output pipeline (no patch rows beyond the header).
    expect(
      toolUseDisplayLines(
        toolUse('Bash', {
          command: 'echo hi',
        }),
      ),
    ).toEqual(['● Bash (echo hi)', '⎿ (no output)']);
    // A failed edit shows the error corner instead of a patch preview.
    expect(
      toolUseDisplayLines(
        toolUse(
          'Edit',
          {
            path: 'paper.tex',
            old_string: 'old',
            new_string: 'new',
          },
          { errorText: 'edit failed', isError: true },
        ),
      ),
    ).toEqual(['● Edit (paper.tex)', '⎿ edit failed']);
  });

  it('maps semantic spans to Ink text styles', () => {
    const lines = toolUseStyledLines(
      toolUse(
        'bash',
        { command: 'false' },
        { errorText: 'command failed', isError: true },
      ),
    );
    const errorLine = lines.at(-1);
    if (errorLine?.kind !== 'row') throw new Error('expected an error row');

    expect(toolDisplaySpanTextProps(errorLine.spans[0])).toEqual({
      bold: undefined,
      color: undefined,
      dimColor: true,
    });
    expect(toolDisplaySpanTextProps(errorLine.spans[1])).toEqual({
      bold: undefined,
      color: 'red',
      dimColor: false,
    });
  });

  it('renders a styled tail when a tool exceeds its bounded viewport', async () => {
    const rendered = await renderBoundedTool(
      toolUse(
        'bash',
        { command: 'npm test' },
        {
          errorText: 'Command failed (exit 2)',
          isError: true,
          outputText: numberedLines(20),
          exitCode: 2,
        },
      ),
      2,
    );

    expect(rendered.split('\n').map((line) => line.trimStart())).toEqual([
      '⎿ exit 2',
      '⎿ Command failed (exit 2)',
    ]);
    expect(rendered).not.toContain('line 20');
    expect(rendered).not.toContain('● bash');
  });
});

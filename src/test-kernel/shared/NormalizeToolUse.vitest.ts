import { describe, expect, it } from 'vitest';

import { normalizeToolUse } from '@shared/toolUse';

describe('normalizeToolUse (src/shared/toolUse.ts)', () => {
  it('extracts toolName, input, and output text from a flat payload', () => {
    const normalized = normalizeToolUse({
      toolName: 'Bash',
      input: { command: 'ls' },
      output: 'foo\nbar',
      status: 'completed',
    });

    expect(normalized?.toolName).toBe('Bash');
    expect(normalized?.input).toEqual({ command: 'ls' });
    expect(normalized?.outputText).toBe('foo\nbar');
    expect(normalized?.status).toBe('completed');
  });

  // Regression: a previous inline refactor of `formatOutputText` dropped
  // the explicit `null` short-circuit that `stringifyWithLanguage` had,
  // so `output: null` fell through to `yaml.stringify(null)` and surfaced
  // the literal text "null" in the rendered output section. Verify both
  // the top-level and nested cases stay empty.
  it('renders null output as empty text, not the string "null"', () => {
    const topLevel = normalizeToolUse({
      toolName: 'Bash',
      input: { command: 'true' },
      output: null,
      status: 'completed',
    });
    expect(topLevel?.outputText).toBe('');

    const nested = normalizeToolUse({
      toolName: 'Bash',
      input: { command: 'true' },
      output: { output: null, summary: 'ran ok' },
      status: 'completed',
    });
    expect(nested?.outputText).toBe('');
    expect(nested?.headerSummary).toBe('ran ok');
  });

  it('unwraps nested `output` and metadata fields', () => {
    const normalized = normalizeToolUse({
      toolName: 'Bash',
      output: {
        output: 'stdout content',
        summary: 'ran 1 command',
      },
      status: 'completed',
    });
    expect(normalized?.outputText).toBe('stdout content');
    expect(normalized?.headerSummary).toBe('ran 1 command');
  });

  it('retains only the scalar exit code needed by renderers', () => {
    const normalized = normalizeToolUse({
      toolName: 'Bash',
      exitCode: 7,
      output: 'failed',
      status: 'completed',
    });

    expect(normalized?.exitCode).toBe(7);
    expect(normalized).not.toHaveProperty('parsed');
  });

  it('leaves exitCode unset when the row states none, prose regardless', () => {
    const normalized = normalizeToolUse({
      toolName: 'Bash',
      error: 'Command failed (exit 3)',
      status: 'failed',
    });
    expect(normalized?.exitCode).toBeUndefined();
  });

  it('reports errors via status and errorText', () => {
    const normalized = normalizeToolUse({
      toolName: 'Bash',
      output: { error: 'no such file' },
      status: 'failed',
    });
    expect(normalized?.status).toBe('failed');
    expect(normalized?.errorText).toBe('no such file');
    // headerSummary falls back to errorText when there's no summary
    expect(normalized?.headerSummary).toBe('no such file');
  });

  it('keeps a status-only runtime failure failed', () => {
    const normalized = normalizeToolUse({
      toolName: 'Bash',
      status: 'failed',
    });

    expect(normalized).toMatchObject({ status: 'failed', errorText: '' });
  });

  it('treats userInstruction as a feedback marker', () => {
    const normalized = normalizeToolUse({
      toolName: 'AskUserQuestion',
      output: { userInstruction: 'pick option A' },
      status: 'completed',
    });
    expect(normalized?.isUserFeedback).toBe(true);
    expect(normalized?.userInstructionText).toBe('pick option A');
    // headerSummary skips errorText when this is feedback
    expect(normalized?.headerSummary).toBe('');
  });
});

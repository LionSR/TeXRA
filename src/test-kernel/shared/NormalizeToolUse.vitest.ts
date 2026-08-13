import { describe, expect, it } from 'vitest';

import { normalizeToolUseData } from '@shared/toolUse';

describe('normalizeToolUseData', () => {
  it('returns null for non-object payloads', () => {
    expect(normalizeToolUseData('not an object')).toBeNull();
    expect(normalizeToolUseData(42)).toBeNull();
    expect(normalizeToolUseData(null)).toBeNull();
  });

  it('extracts toolName, input, and output text from a flat payload', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      input: { command: 'ls' },
      output: 'foo\nbar',
      status: 'completed',
    });

    expect(normalized?.toolName).toBe('Bash');
    expect(normalized?.input).toEqual({ command: 'ls' });
    expect(normalized?.outputText).toBe('foo\nbar');
    expect(normalized?.status).toBe('completed');
    expect(normalized?.isError).toBe(false);
  });

  // Regression: a previous inline refactor of `formatOutputText` dropped
  // the explicit `null` short-circuit that `stringifyWithLanguage` had,
  // so `output: null` fell through to `yaml.stringify(null)` and surfaced
  // the literal text "null" in the rendered output section. Verify both
  // the top-level and nested cases stay empty.
  it('renders null output as empty text, not the string "null"', () => {
    const topLevel = normalizeToolUseData({
      toolName: 'Bash',
      input: { command: 'true' },
      output: null,
      status: 'completed',
    });
    expect(topLevel?.outputText).toBe('');

    const nested = normalizeToolUseData({
      toolName: 'Bash',
      input: { command: 'true' },
      output: { output: null, summary: 'ran ok' },
      status: 'completed',
    });
    expect(nested?.outputText).toBe('');
    expect(nested?.headerSummary).toBe('ran ok');
  });

  it('unwraps nested `output` and metadata fields', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      output: {
        output: 'stdout content',
        summary: 'ran 1 command',
        isError: false,
      },
      status: 'completed',
    });
    expect(normalized?.outputText).toBe('stdout content');
    expect(normalized?.headerSummary).toBe('ran 1 command');
  });

  it('retains only the scalar exit code needed by renderers', () => {
    const topLevel = normalizeToolUseData({
      toolName: 'Bash',
      exit_code: 7,
      output: 'failed',
      status: 'completed',
    });
    const nested = normalizeToolUseData({
      toolName: 'Bash',
      output: { exitCode: 3, output: 'failed' },
      status: 'completed',
    });

    expect(topLevel?.exitCode).toBe(7);
    expect(nested?.exitCode).toBe(3);
    expect(topLevel).not.toHaveProperty('parsed');
  });

  it('derives the exit code from prose when no structured field exists', () => {
    const fromError = normalizeToolUseData({
      toolName: 'Bash',
      error: 'Command failed (exit 7)',
      status: 'failed',
    });
    const fromSummary = normalizeToolUseData({
      toolName: 'Bash',
      output: {
        summary: 'Background bash failed with exit code 2.',
        isError: true,
      },
      status: 'completed',
    });

    expect(fromError?.exitCode).toBe(7);
    expect(fromSummary?.exitCode).toBe(2);
  });

  it('prefers a structured exit code over prose', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      exit_code: 7,
      error: 'Command failed (exit 3)',
      status: 'failed',
    });
    expect(normalized?.exitCode).toBe(7);
  });

  it('leaves exitCode unset when prose mentions no exit code', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      error: 'cancelled by user',
      status: 'failed',
    });
    expect(normalized?.exitCode).toBeUndefined();
  });

  it('reports errors via isError and errorText', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      output: { error: 'no such file', isError: true },
      status: 'completed',
    });
    expect(normalized?.isError).toBe(true);
    expect(normalized?.status).toBe('failed');
    expect(normalized?.errorText).toBe('no such file');
    // headerSummary falls back to errorText when there's no summary
    expect(normalized?.headerSummary).toBe('no such file');
  });

  it('accepts failed runtime tool status directly', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      error: 'cancelled by user',
      status: 'failed',
    });

    expect(normalized).toMatchObject({
      errorText: 'cancelled by user',
      isError: true,
      status: 'failed',
    });
  });

  it('treats a status-only runtime failure as an error', () => {
    const normalized = normalizeToolUseData({
      toolName: 'Bash',
      status: 'failed',
    });

    expect(normalized).toMatchObject({
      isError: true,
      status: 'failed',
    });
  });

  it('treats userInstruction as a feedback marker', () => {
    const normalized = normalizeToolUseData({
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

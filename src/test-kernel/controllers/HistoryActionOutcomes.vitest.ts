import { describe, expect, it } from 'vitest';

import {
  ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE,
  describeClearHistoryResult,
  describeDeleteExecutionResult,
  describeLatexExportResult,
  exportedFileMessage,
  exportInputErrorMessage,
  HISTORY_CLEARED_MESSAGE,
  HISTORY_CONFIG_UNREADABLE_MESSAGE,
  htmlExportErrorMessage,
} from '@controllers/settingsView/HistoryActionOutcomes';
import type { ExecutionId } from '@shared/schemas';

const EXECUTION_ID = 'abc123' as ExecutionId;

function latexResultFixture(
  overrides: Partial<Parameters<typeof describeLatexExportResult>[0]> = {},
): Parameters<typeof describeLatexExportResult>[0] {
  return {
    storagePath: 'executions/abc/chat.tex',
    absolutePath: '/tmp/executions/abc/chat.tex',
    ...overrides,
  };
}

describe('HistoryActionOutcomes', () => {
  it.each([
    ['config_missing', 'History item not found'],
    [
      'conversation_missing',
      'No conversation data available for this execution',
    ],
  ] as const)(
    'maps export-input error %s to its message',
    (status, message) => {
      expect(exportInputErrorMessage(status)).toBe(message);
    },
  );

  it.each([
    ['config_missing', 'History item not found'],
    [
      'streamLogs_missing',
      'No transcript was saved for this run, so there is nothing to export. Try exporting a more recent run.',
    ],
  ] as const)('maps html export error %s to its message', (status, message) => {
    expect(htmlExportErrorMessage(status)).toBe(message);
  });

  it('formats the exported-file message from a storage path', () => {
    expect(exportedFileMessage('executions/abc/chat.md')).toBe(
      'Chat exported: chat.md',
    );
  });

  it('describes a compiled LaTeX export', () => {
    const outcome = describeLatexExportResult(
      latexResultFixture({ pdfPath: '/tmp/executions/abc/chat.pdf' }),
    );

    expect(outcome).toEqual({
      kind: 'compiled',
      pathToOpen: '/tmp/executions/abc/chat.pdf',
      message: 'Chat exported and compiled: chat.pdf',
    });
  });

  it('describes a failed LaTeX compilation with a log tail', () => {
    const outcome = describeLatexExportResult(
      latexResultFixture({ logTail: '! Undefined control sequence.' }),
    );

    expect(outcome).toEqual({
      kind: 'compileFailed',
      pathToOpen: '/tmp/executions/abc/chat.tex',
      message:
        'LaTeX compilation failed. The .tex source file has been opened instead.',
      logDetail:
        'LaTeX export compilation failed for executions/abc/chat.tex:\n! Undefined control sequence.',
    });
  });

  it('describes a failed LaTeX compilation without a log tail', () => {
    const outcome = describeLatexExportResult(latexResultFixture());

    expect(outcome).toEqual({
      kind: 'compileFailed',
      pathToOpen: '/tmp/executions/abc/chat.tex',
      message:
        'LaTeX compilation failed. The .tex source file has been opened instead.',
      logDetail: undefined,
    });
  });

  it.each([
    [
      'active',
      { status: 'active', executionId: EXECUTION_ID, heartbeatAt: 0 },
      { kind: 'active' },
    ],
    [
      'not-found',
      { status: 'not-found', executionId: EXECUTION_ID },
      { kind: 'not-found', message: `History item not found: ${EXECUTION_ID}` },
    ],
    [
      'deleted',
      { status: 'deleted', executionId: EXECUTION_ID },
      { kind: 'deleted' },
    ],
  ] as const)('describes a %s delete result', (_status, input, expected) => {
    expect(describeDeleteExecutionResult(input)).toEqual(expected);
  });

  it('exposes the message constants both hosts share', () => {
    expect(ACTIVE_EXECUTION_DELETE_BLOCKED_MESSAGE).toBe(
      'Cannot delete an execution that is active in TeXRA',
    );
    expect(HISTORY_CLEARED_MESSAGE).toBe('Agent history cleared');
    // readConfig() returns null for missing and corrupt alike, so the copy
    // must not narrow the cause to "not found".
    expect(HISTORY_CONFIG_UNREADABLE_MESSAGE).toBe(
      'History item not found or unreadable (missing, corrupt, or from an incompatible version)',
    );
  });

  it('describes a fully cleared history result', () => {
    expect(
      describeClearHistoryResult({
        deleted: [EXECUTION_ID],
        notFound: [],
        active: [],
        failed: [],
      }),
    ).toEqual({ kind: 'cleared' });
  });

  it('describes a partially retained history result', () => {
    expect(
      describeClearHistoryResult({
        deleted: [],
        notFound: [],
        active: [EXECUTION_ID],
        failed: [],
      }),
    ).toEqual({
      kind: 'retained',
      message: 'Cleared stored history except for 1 active execution.',
    });
  });
});

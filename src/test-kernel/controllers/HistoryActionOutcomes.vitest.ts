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
  it('maps export-input error statuses to messages', () => {
    expect(exportInputErrorMessage('config_missing')).toBe(
      'History item not found',
    );
    expect(exportInputErrorMessage('conversation_missing')).toBe(
      'No conversation data available for this execution',
    );
  });

  it('maps html export error statuses to messages', () => {
    expect(htmlExportErrorMessage('config_missing')).toBe(
      'History item not found',
    );
    expect(htmlExportErrorMessage('rootStream_missing')).toBe(
      'No root transcript is available for trace export; this execution is represented only by delegated child streams.',
    );
    expect(htmlExportErrorMessage('streamId_ambiguous')).toBe(
      'Several historical transcripts match this execution, but none is proven canonical for trace export.',
    );
    expect(htmlExportErrorMessage('streamLogs_missing')).toBe(
      'No stored transcript available for this execution — it may predate transcript persistence.',
    );
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

  it('describes an active-execution delete result', () => {
    expect(
      describeDeleteExecutionResult({
        status: 'active',
        executionId: EXECUTION_ID,
        heartbeatAt: 0,
      }),
    ).toEqual({ kind: 'active' });
  });

  it('describes a not-found delete result', () => {
    expect(
      describeDeleteExecutionResult({
        status: 'not-found',
        executionId: EXECUTION_ID,
      }),
    ).toEqual({
      kind: 'not-found',
      message: `History item not found: ${EXECUTION_ID}`,
    });
  });

  it('describes a successful delete result', () => {
    expect(
      describeDeleteExecutionResult({
        status: 'deleted',
        executionId: EXECUTION_ID,
      }),
    ).toEqual({ kind: 'deleted' });
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

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendCliApiSwitchHint,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
  immediateDecisionForApproval,
  installCliApprovalHandlers,
  isCliApiSwitchableRetry,
} from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  requestToolEditApproval,
  setToolEditApprovalHandler,
} from '@tools/approval/toolEditApproval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    colorEnabled: false,
    version: 'test',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

const credentialExhaustedRetry: ProgressEventPayloads['showRetryRequest'] = {
  streamId:
    'test-stream' as ProgressEventPayloads['showRetryRequest']['streamId'],
  operation: 'Tool-use call',
  errorMessage: 'HTTP 429 Too Many Requests',
  errorDetails: {
    isCredentialExhausted: true,
    isRelayError: true,
    statusCode: 429,
  },
};

afterEach(() => {
  setToolEditApprovalHandler();
});

describe('immediateDecisionForApproval', () => {
  it('shows the interactive retry panel for exhausted credentials', () => {
    expect(
      immediateDecisionForApproval(
        'showRetryRequest',
        credentialExhaustedRetry,
        context(),
      ),
    ).toBeUndefined();
  });

  it('denies exhausted credential retries outside interactive ask mode', () => {
    expect(
      immediateDecisionForApproval(
        'showRetryRequest',
        credentialExhaustedRetry,
        context({ approvalPolicy: 'yolo' }),
      ),
    ).toMatchObject({ accepted: false });

    expect(
      immediateDecisionForApproval(
        'showRetryRequest',
        credentialExhaustedRetry,
        context({ mode: 'headless' }),
      ),
    ).toMatchObject({ accepted: false });
  });
});

describe('formatToolEditApprovalSummary', () => {
  it('includes the proposed edit diff in interactive CLI prompts', () => {
    const summary = formatToolEditApprovalSummary({
      path: '/tmp/proof.tex',
      originalContent: 'Let G be a group.\nThis is wrong.\n',
      proposedContent: 'Let G be a group.\nThis is correct.\n',
      sourceTool: 'edit_file',
    });

    expect(summary).toContain('Tool edit requested by edit_file');
    expect(summary).toContain('Proposed diff:');
    expect(summary).toContain('-This is wrong.');
    expect(summary).toContain('+This is correct.');
  });

  it('passes the diff summary to the interactive approval prompt', async () => {
    let promptSummary = '';
    installCliApprovalHandlers(
      context({
        approvalPrompt: async (request) => {
          promptSummary = request.summary;
          return 'n';
        },
      }),
    );

    const result = await requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
    });

    expect(result.accepted).toBe(false);
    expect(promptSummary).toContain('Tool edit requested by write_file');
    expect(promptSummary).toContain('+\\section{Proof}');
    expect(promptSummary).toContain('+A concise proof.');
  });

  it('bounds long diff lines before prompting', () => {
    const longLine = 'x'.repeat(1_000);
    const summary = formatToolEditApprovalSummary({
      path: '/tmp/generated.json',
      originalContent: '',
      proposedContent: `${longLine}\n`,
      sourceTool: 'write_file',
    });

    expect(summary).toContain('[line truncated]');
    expect(summary).not.toContain(longLine);
    expect(summary.length).toBeLessThan(1_000);
  });

  it('marks hidden diff lines when the line budget is exceeded', () => {
    const proposedContent = Array.from(
      { length: 100 },
      (_, index) => `generated line ${index + 1}`,
    ).join('\n');
    const summary = formatToolEditApprovalSummary({
      path: '/tmp/generated.tex',
      originalContent: '',
      proposedContent,
      sourceTool: 'write_file',
    });

    expect(summary).toContain('diff lines hidden');
  });

  it('skips prompting for auto-approved edits', async () => {
    installCliApprovalHandlers(
      context({
        approvalPolicy: 'yolo',
        approvalPrompt: async () => {
          throw new Error('approval prompt should not be called');
        },
      }),
    );

    const result = await requestToolEditApproval({
      path: '/tmp/auto-approved.tex',
      originalContent: '',
      proposedContent: '\\section{Auto-approved}\n',
      sourceTool: 'write_file',
    });

    expect(result).toMatchObject({
      accepted: true,
      appliedContent: '\\section{Auto-approved}\n',
    });
  });
});

describe('formatRetryRequestMessage', () => {
  it('shows the API-key switch for exhausted included access', () => {
    expect(formatRetryRequestMessage(credentialExhaustedRetry)).toContain(
      '/api personal',
    );
  });

  it('recognizes relay monthly-limit text when the relay body is absent', () => {
    const retry: ProgressEventPayloads['showRetryRequest'] = {
      ...credentialExhaustedRetry,
      errorMessage:
        'HTTP 429 Too Many Requests – 429 Monthly spending limit reached ($300).',
      errorDetails: {
        isCredentialExhausted: true,
        isRelayError: false,
        statusCode: 429,
      },
    };

    expect(isCliApiSwitchableRetry(retry)).toBe(true);
    expect(appendCliApiSwitchHint(retry.errorMessage!)).toContain(
      '/api personal',
    );
  });
});

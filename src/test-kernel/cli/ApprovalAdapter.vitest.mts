import { describe, expect, it } from 'vitest';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  formatRetryRequestMessage,
  immediateDecisionForApproval,
} from '../../../packages/cli/src/runtime/approvalAdapter';
import type { CliContext } from '../../../packages/cli/src/runtime/cliContext';

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

describe('formatRetryRequestMessage', () => {
  it('shows the API-key switch for exhausted included access', () => {
    expect(formatRetryRequestMessage(credentialExhaustedRetry)).toContain(
      '/api personal',
    );
  });
});

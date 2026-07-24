// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared tools
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';

describe('deriveToolInputPreview', () => {
  it('reads the command field for bash', () => {
    expect(deriveToolInputPreview('bash', { command: 'npm test' })).toBe(
      'npm test',
    );
  });

  it('reads the prompt field for codex', () => {
    expect(
      deriveToolInputPreview('codex', { prompt: 'Summarize this proof.' }),
    ).toBe('Summarize this proof.');
  });

  it('composes action and path for executions', () => {
    expect(
      deriveToolInputPreview('executions', {
        action: 'view',
        path: '/executions/process-1',
      }),
    ).toBe('view /executions/process-1');
  });

  it('defaults the executions action when omitted', () => {
    expect(
      deriveToolInputPreview('executions', { path: '/executions/abc' }),
    ).toBe('view /executions/abc');
  });

  it('returns an empty string for unmapped tools', () => {
    expect(deriveToolInputPreview('read_file', { path: 'paper.tex' })).toBe('');
  });

  it('returns an empty string for non-object input', () => {
    expect(deriveToolInputPreview('bash', 'npm test')).toBe('');
    expect(deriveToolInputPreview('bash', undefined)).toBe('');
  });
});

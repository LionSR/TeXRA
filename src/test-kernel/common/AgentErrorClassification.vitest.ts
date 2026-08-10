/**
 * `classifyAgentError` is the single terminal-error taxonomy. These tests pin
 * the two producer-tagged kinds it gained (`context-window`, `missing-api-key`)
 * and, crucially, that the message predicates the tagging replaced are gone:
 * an error that merely *says* "Missing API key" no longer classifies as one.
 */
import { describe, expect, it } from 'vitest';

import {
  AGENT_ERROR_OUTCOME,
  type AgentErrorKind,
  classifyAgentError,
} from '@common/errors/agentErrorClassification';
import {
  attachContextWindowError,
  attachMissingApiKeyError,
} from '@common/errors/sdkError/errorMetadata';
import { RUN_OUTCOME } from '@shared/schemas';

function diskFullError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('write failed');
  err.code = 'ENOSPC';
  return err;
}

describe('classifyAgentError', () => {
  it('classifies a user abort ahead of every other kind', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    expect(classifyAgentError(abort)).toBe('abort');
  });

  it('classifies a local ENOSPC failure as disk-full', () => {
    expect(classifyAgentError(diskFullError())).toBe('disk-full');
  });

  it('finds the missing-api-key marker through a rewrapping cause chain', () => {
    // The marker is attached at ModelHandler.fetchApiKeyOrThrow; anything that
    // rethrows on top of it must stay classifiable.
    const inner = new Error('Missing API key for openai.');
    attachMissingApiKeyError(inner);
    const outer = new Error('Failed to build the model client', {
      cause: inner,
    });

    expect(classifyAgentError(outer)).toBe('missing-api-key');
  });

  it('does not classify a message that merely mentions a missing API key', () => {
    // The deleted predicates matched these two strings anywhere in a message.
    // Only the throw-site marker classifies now, so a model's prose, a tool
    // result, or a log line quoting the phrase cannot hijack the taxonomy.
    expect(
      classifyAgentError(
        new Error('Tool output: "Missing API key" appeared in the build log'),
      ),
    ).toBe('unexpected');
    expect(
      classifyAgentError(new Error('No API key found for acme in their docs')),
    ).toBe('unexpected');
  });

  it('classifies a TeXRA-internal context-window throw via its marker', () => {
    const err = new Error(
      'Token count of message exceeds context window: 5 > 3',
    );
    attachContextWindowError(err);

    expect(classifyAgentError(err)).toBe('context-window');
  });

  it('classifies a third-party provider overflow as context-window', () => {
    expect(
      classifyAgentError(new Error('maximum context length is 128000')),
    ).toBe('context-window');
  });

  it('leaves an unrecognized provider failure unexpected', () => {
    expect(classifyAgentError(new Error('provider exploded'))).toBe(
      'unexpected',
    );
  });

  it('prefers the credential marker over a context-window message', () => {
    // A credential failure rewrapped by a caller whose wording happens to
    // mention the context window must still route to the actionable
    // set-your-key toast, not the "start a new session" one.
    const err = new Error('maximum context length is 128000');
    attachMissingApiKeyError(err);

    expect(classifyAgentError(err)).toBe('missing-api-key');
  });
});

describe('AGENT_ERROR_OUTCOME', () => {
  it('maps every kind, with abort the only cancellation', () => {
    const kinds: readonly AgentErrorKind[] = [
      'abort',
      'context-window',
      'disk-full',
      'missing-api-key',
      'unexpected',
    ];

    expect(Object.keys(AGENT_ERROR_OUTCOME).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      expect(AGENT_ERROR_OUTCOME[kind]).toBe(
        kind === 'abort' ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.FAILED,
      );
    }
  });
});

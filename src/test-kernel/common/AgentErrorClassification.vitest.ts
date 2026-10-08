/**
 * `classifyAgentError` is the single terminal-error taxonomy. These tests pin
 * the two producer-tagged kinds it gained (`context-window`, `missing-api-key`)
 * and, crucially, that the message predicates the tagging replaced are gone:
 * an error that merely *says* "Missing API key" no longer classifies as one.
 */
import { describe, expect, it } from 'vitest';
import { ModelError } from '@texra-ai/llm';

import {
  agentErrorPresentation,
  classifyAgentError,
} from '@common/errors/agentErrorClassification';
import { RouteUnavailable } from '@common/errors/agentErrors';

const missingKey = (message: string) =>
  new RouteUnavailable({ reason: 'missing-api-key', message });

describe('classifyAgentError', () => {
  it('classifies a user abort ahead of every other kind', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    expect(classifyAgentError(abort)).toBe('abort');
  });

  it('classifies a local ENOSPC failure as disk-full', () => {
    const err: NodeJS.ErrnoException = new Error('write failed');
    err.code = 'ENOSPC';
    expect(classifyAgentError(err)).toBe('disk-full');
  });

  it('finds a missing key through a rewrapping cause chain', () => {
    // Model access fails with it where the credential is read; anything that
    // rethrows on top of it must stay classifiable.
    const inner = missingKey('Missing API key for openai.');
    const outer = new Error('Failed to build the model client', {
      cause: inner,
    });

    expect(classifyAgentError(outer)).toBe('missing-api-key');
  });

  it('does not classify a message that merely mentions a missing API key', () => {
    // The deleted predicates matched these two strings anywhere in a message.
    // Only the typed failure classifies now, so a model's prose, a tool
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

  it('classifies an overflowed window by llm verdict', () => {
    const err = new ModelError({
      kind: 'context-overflow',
      message: 'Token count of message exceeds context window: 5 > 3',
    });

    expect(classifyAgentError(err)).toBe('context-window');
  });

  it('does not classify a message that merely mentions the context window', () => {
    // A provider's overflow is the llm package's verdict; prose quoting the
    // phrase cannot hijack the taxonomy.
    expect(
      classifyAgentError(new Error('maximum context length is 128000')),
    ).toBe('unexpected');
  });

  it('prefers a missing key over a context-window message', () => {
    // A credential failure whose wording happens to mention the context
    // window must still route to the actionable set-your-key toast, not the
    // "start a new session" one.
    const err = missingKey('maximum context length is 128000');

    expect(classifyAgentError(err)).toBe('missing-api-key');
  });
});

describe('agentErrorPresentation', () => {
  it("threads a refusing request's docsPage into the error payload", () => {
    // The desktop host presents request rejections as a native dialog built
    // from this payload; dropping docsPage here loses the launch
    // refusal's guide link (#11959).
    expect(
      agentErrorPresentation({
        kind: 'unexpected',
        message: 'Choose an input file first.',
        docsPage: 'file-management',
      }),
    ).toStrictEqual({
      type: 'error',
      payload: {
        message: 'Choose an input file first.',
        docsPage: 'file-management',
      },
    });
  });
});

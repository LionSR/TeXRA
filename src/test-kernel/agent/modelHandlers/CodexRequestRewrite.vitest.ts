import { describe, expect, it } from 'vitest';

import {
  CODEX_DEFAULT_INSTRUCTIONS,
  isGenerationRequest,
  rewriteCodexRequestBody,
} from '@agent/modelHandlers/openai/modelHandlerCodex';

/**
 * Golden fixtures for the reverse-engineered Codex `/responses` wire contract.
 * The backend is unofficial and unvalidatable from a schema, so the request
 * shape this code emits IS the spec — each fixture pins one named invariant
 * from {@link rewriteCodexRequestBody}'s contract. A change here is a
 * deliberate change to what we send Codex.
 */
describe('rewriteCodexRequestBody', () => {
  it('drops max_output_tokens and forces the stateless streaming shape', () => {
    expect(
      rewriteCodexRequestBody({
        model: 'gpt-5.5',
        max_output_tokens: 1024,
        input: [{ role: 'user', content: 'Hello' }],
      }),
    ).toEqual({
      model: 'gpt-5.5',
      store: false,
      stream: true,
      input: [{ role: 'user', content: 'Hello' }],
      instructions: CODEX_DEFAULT_INSTRUCTIONS,
    });
  });

  it('rewrites date-pinned OpenAI model ids to the bare Codex backend id', () => {
    const out = rewriteCodexRequestBody({
      model: 'gpt-5.5-2026-04-23',
      input: [{ role: 'user', content: 'Hello' }],
    });

    expect(out.model).toBe('gpt-5.5');
  });

  it('drops a non-background-mode background flag and forces store/stream', () => {
    const out = rewriteCodexRequestBody({
      background: false,
      store: true,
      stream: false,
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(out).not.toHaveProperty('background');
    expect(out.store).toBe(false);
    expect(out.stream).toBe(true);
  });

  it('hoists system/developer items into instructions and keeps the rest of input', () => {
    expect(
      rewriteCodexRequestBody({
        input: [
          { role: 'system', content: 'You are Codex.' },
          { role: 'developer', content: 'Be terse.' },
          { role: 'user', content: 'Solve x+1=2.' },
        ],
      }),
    ).toEqual({
      store: false,
      stream: true,
      instructions: 'You are Codex.\n\nBe terse.',
      input: [{ role: 'user', content: 'Solve x+1=2.' }],
    });
  });

  it('flattens typed content parts when hoisting instructions', () => {
    const out = rewriteCodexRequestBody({
      input: [
        {
          role: 'developer',
          content: [
            { type: 'input_text', text: 'Be terse.' },
            { type: 'input_text', text: 'Use SI units.' },
          ],
        },
        { role: 'user', content: 'go' },
      ],
    });
    expect(out.instructions).toBe('Be terse.\nUse SI units.');
    expect(out.input).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('prepends an existing top-level instructions string before hoisted text', () => {
    const out = rewriteCodexRequestBody({
      instructions: 'Top instr.',
      input: [
        { role: 'system', content: 'Sys instr.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(out.instructions).toBe('Top instr.\n\nSys instr.');
  });

  it('does not duplicate hoisted text already covered by existing instructions', () => {
    const out = rewriteCodexRequestBody({
      instructions: 'Base policy applies here.',
      input: [
        { role: 'system', content: 'Base policy' },
        { role: 'user', content: 'hi' },
      ],
    });
    // "Base policy" is a substring of the existing instruction, so it is not
    // re-appended.
    expect(out.instructions).toBe('Base policy applies here.');
  });

  it('falls back to the default instructions when none can be derived', () => {
    const out = rewriteCodexRequestBody({
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(out.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
  });

  it('strips background entirely — the Codex backend has no background mode', () => {
    // Probed directly: background:true returns 400 "Unsupported parameter:
    // background" even with store:false/stream:true satisfied. So the rewriter
    // always strips it and forces the working stateless streaming shape.
    expect(
      rewriteCodexRequestBody({
        background: true,
        store: true,
        max_output_tokens: 50,
        input: [
          { role: 'system', content: 'S' },
          { role: 'user', content: 'u' },
        ],
      }),
    ).toEqual({
      store: false,
      stream: true,
      instructions: 'S',
      input: [{ role: 'user', content: 'u' }],
    });
  });

  it('is pure — it never mutates the caller body', () => {
    const body = {
      max_output_tokens: 10,
      input: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'u' },
      ],
    };
    const snapshot = structuredClone(body);
    rewriteCodexRequestBody(body);
    expect(body).toEqual(snapshot);
  });

  it.each(['high', 'xhigh', 'max'])(
    'clamps %s reasoning effort down to medium (no background mode to absorb a long synchronous turn)',
    (effort) => {
      const out = rewriteCodexRequestBody({
        input: [{ role: 'user', content: 'hi' }],
        reasoning: { effort },
      });
      expect(out.reasoning).toEqual({ effort: 'medium' });
    },
  );

  it.each(['low', 'medium'])(
    'leaves %s reasoning effort unchanged',
    (effort) => {
      const out = rewriteCodexRequestBody({
        input: [{ role: 'user', content: 'hi' }],
        reasoning: { effort },
      });
      expect(out.reasoning).toEqual({ effort });
    },
  );
});

describe('isGenerationRequest', () => {
  it('matches only the generation endpoint, not token counting', () => {
    expect(
      isGenerationRequest('https://chatgpt.com/backend-api/codex/responses'),
    ).toBe(true);
    expect(
      isGenerationRequest(
        'https://chatgpt.com/backend-api/codex/responses/input_tokens',
      ),
    ).toBe(false);
    expect(isGenerationRequest('https://api.openai.com/v1/responses')).toBe(
      true,
    );
  });
});

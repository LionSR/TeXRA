import { afterEach, describe, expect, it, vi } from 'vitest';

const helperModelMock = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
}));

const polishModelMock = vi.hoisted(() => ({
  initializePolishModel: vi.fn(),
  renderPolishPrompt: vi.fn(),
}));

vi.mock('@agent/runtime/helperModel', () => helperModelMock);
vi.mock('@agent/runtime/polishModel', () => polishModelMock);

import {
  initializeRuntimeTextPolish,
  requestRuntimeTextPolish,
} from '@agent/runtime/textPolishCommands';

describe('runtime text polish commands', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes the host-provided polish prompt through the runtime boundary', () => {
    initializeRuntimeTextPolish({
      promptTemplatePath: '/resources/templates/instructionPolish.yaml',
    });

    expect(polishModelMock.initializePolishModel).toHaveBeenCalledWith(
      '/resources/templates/instructionPolish.yaml',
    );
  });

  it('renders context, invokes the helper model, and extracts corrected text', async () => {
    const handler = {
      initializeMessages: vi.fn(async () => [{ role: 'user', content: 'p' }]),
      createResponse: vi.fn(async () => ({ response: 'response' })),
      extractResponse: vi.fn(() => ({
        text: '<corrected_text>Improved text.</corrected_text>',
      })),
    };
    polishModelMock.renderPolishPrompt.mockResolvedValue('rendered prompt');
    helperModelMock.createHelperModelKit.mockResolvedValue({
      kit: { handler, client: { id: 'client' } },
    });

    await expect(
      requestRuntimeTextPolish({
        text: 'improve me',
        fileContext: {
          agent: 'writer',
          inputFiles: ['main.tex'],
        },
      }),
    ).resolves.toEqual({ success: true, text: 'Improved text.' });

    expect(polishModelMock.renderPolishPrompt.mock.calls[0]?.[0]).toContain(
      'Agent: writer',
    );
    expect(polishModelMock.renderPolishPrompt.mock.calls[0]?.[0]).toContain(
      'Input Files: main.tex',
    );
    expect(polishModelMock.renderPolishPrompt.mock.calls[0]?.[1]).toBe(
      'improve me',
    );
    expect(handler.initializeMessages).toHaveBeenCalledWith(
      '',
      'rendered prompt',
    );
    expect(handler.createResponse).toHaveBeenCalledWith({
      client: { id: 'client' },
      messages: [{ role: 'user', content: 'p' }],
      temperature: 0,
    });
  });

  it('returns the original text when helper model creation fails', async () => {
    polishModelMock.renderPolishPrompt.mockResolvedValue('rendered prompt');
    helperModelMock.createHelperModelKit.mockResolvedValue({
      reason: 'No helper model is configured.',
    });

    await expect(requestRuntimeTextPolish({ text: 'draft' })).resolves.toEqual({
      success: false,
      text: 'draft',
      error: 'No helper model is configured.',
    });
  });
});

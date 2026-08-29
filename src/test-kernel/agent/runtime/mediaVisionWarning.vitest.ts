// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { mediaNeedsVisionWarning } from '@agent/runtime/mediaVisionWarning';

describe('media vision warnings', () => {
  it.each([
    {
      name: 'warns for attached media when native audio is supported but vision is not',
      files: ['figure.png'],
      capabilities: { supportsNativeAudio: true, supportsVision: false },
      kind: 'attached' as const,
      modelName: 'deepseek-chat',
      expected:
        'Model "deepseek-chat" has no vision support: 1 attached media file is not sent to the model. Switch to a vision-capable model to use it.',
    },
    {
      name: 'counts only media files that need vision',
      files: ['figure.png', 'voice.mp3', 'document.pdf'],
      capabilities: { supportsVision: false },
      kind: 'pasted' as const,
      modelName: undefined,
      expected:
        'Model has no vision support: 2 pasted media files are not sent to the model. Switch to a vision-capable model to use them.',
    },
    {
      name: 'does not warn for audio-only media on non-vision models',
      files: ['voice.mp3'],
      capabilities: { supportsVision: false },
      kind: 'attached' as const,
      modelName: undefined,
      expected: undefined,
    },
    {
      name: 'does not warn when there are no media files',
      files: [],
      capabilities: { supportsVision: false },
      kind: 'attached' as const,
      modelName: undefined,
      expected: undefined,
    },
    {
      name: 'does not warn when vision is supported',
      files: ['figure.png'],
      capabilities: { supportsVision: true },
      kind: 'attached' as const,
      modelName: undefined,
      expected: undefined,
    },
  ])('$name', ({ files, capabilities, kind, modelName, expected }) => {
    expect(mediaNeedsVisionWarning(files, capabilities, kind, modelName)).toBe(
      expected,
    );
  });
});

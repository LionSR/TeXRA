// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from '@agent/runtime/mediaVisionWarning';

describe('media vision warnings', () => {
  it.each([
    {
      name: 'warns for attached media when native audio is supported but vision is not',
      files: ['figure.png'],
      capabilities: { supportsNativeAudio: true, supportsVision: false },
      expected: true,
    },
    {
      name: 'does not warn for audio-only media on non-vision models',
      files: ['voice.mp3'],
      capabilities: { supportsVision: false },
      expected: false,
    },
    {
      name: 'does not warn when there are no media files',
      files: [],
      capabilities: { supportsVision: false },
      expected: false,
    },
    {
      name: 'does not warn when vision is supported',
      files: ['figure.png'],
      capabilities: { supportsVision: true },
      expected: false,
    },
  ])('$name', ({ files, capabilities, expected }) => {
    expect(shouldWarnMediaNeedsVision(files, capabilities)).toBe(expected);
  });

  it('counts only media files that need vision', () => {
    expect(
      countMediaFilesNeedingVision(['figure.png', 'voice.mp3', 'document.pdf']),
    ).toBe(2);
  });

  it('formats startup and follow-up warnings consistently', () => {
    expect(formatMediaNeedsVisionWarning(1, 'attached', 'deepseek-chat')).toBe(
      'Model "deepseek-chat" has no vision support: 1 attached media file is not sent to the model. Switch to a vision-capable model to use it.',
    );
    expect(formatMediaNeedsVisionWarning(2, 'pasted')).toBe(
      'Model has no vision support: 2 pasted media files are not sent to the model. Switch to a vision-capable model to use them.',
    );
  });
});

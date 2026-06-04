// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  shouldWarnMediaNeedsVision,
} from '@agent/runtime/mediaVisionWarning';

describe('media vision warnings', () => {
  it('warns for attached media when native audio is supported but vision is not', () => {
    const capabilities = {
      supportsNativeAudio: true,
      supportsVision: false,
    };

    expect(shouldWarnMediaNeedsVision(['figure.png'], capabilities)).toBe(true);
  });

  it('does not warn for audio-only media on non-vision models', () => {
    expect(
      shouldWarnMediaNeedsVision(['voice.mp3'], {
        supportsVision: false,
      }),
    ).toBe(false);
  });

  it('counts only media files that need vision', () => {
    expect(
      countMediaFilesNeedingVision(['figure.png', 'voice.mp3', 'document.pdf']),
    ).toBe(2);
  });

  it('does not warn when there are no media files or vision is supported', () => {
    expect(
      shouldWarnMediaNeedsVision([], {
        supportsVision: false,
      }),
    ).toBe(false);
    expect(
      shouldWarnMediaNeedsVision(['figure.png'], {
        supportsVision: true,
      }),
    ).toBe(false);
  });

  it('formats startup and follow-up warnings consistently', () => {
    expect(formatMediaNeedsVisionWarning(1, 'attached', 'deepseek-chat')).toBe(
      'Model "deepseek-chat" has no vision support — 1 attached media file is not sent to the model. Switch to a vision-capable model to use it.',
    );
    expect(formatMediaNeedsVisionWarning(2, 'pasted')).toBe(
      'Model has no vision support — 2 pasted media files are not sent to the model. Switch to a vision-capable model to use them.',
    );
  });
});

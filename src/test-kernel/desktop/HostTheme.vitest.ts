import { describe, expect, it } from 'vitest';

// Subject under test - the host-neutral theme helpers shared between the
// VS Code webviews and the Electron renderer.
import { resolvePostMessageTargetOrigin } from '@texra/shared/postMessageOrigin';

describe('resolvePostMessageTargetOrigin', () => {
  it('falls back to "*" when origin is the literal string "null" (file://)', () => {
    // Chromium returns the literal string "null" for file:// URLs. The helper
    // must not pass that through to window.postMessage or messages get
    // silently dropped.
    expect(resolvePostMessageTargetOrigin('null')).toBe('*');
  });
});

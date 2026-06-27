import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('extension agent event listener boundaries', () => {
  it('uses the runtime toast boundary instead of importing the session handle', () => {
    const source = readSource(
      'packages/extension/src/frontend/events/agentEventListeners.ts',
    );

    expect(source).toContain('attachDefaultTerminalResultToast');
    expect(source).not.toMatch(/@agent\/runtime\/SessionHandle/);
    expect(source).not.toMatch(/\bdefaultSession\(/);
    expect(source).not.toMatch(/\battachTerminalResultToast\b/);
  });
});

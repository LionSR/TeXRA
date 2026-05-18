import { describe, expect, it } from 'vitest';

import { rootCommand } from '../../../packages/cli/src/commands/root';
import {
  CLI_COMPLETION_SHELLS,
  generateCompletionScript,
} from '../../../packages/cli/src/runtime/completion';

describe('CLI shell completion', () => {
  for (const shell of CLI_COMPLETION_SHELLS) {
    it(`generates ${shell} completion`, async () => {
      const script = await generateCompletionScript(rootCommand, shell);

      expect(script).toMatchSnapshot();
    });
  }

  it('keeps dynamic completion gated by TEXRA_COMPLETION_DYNAMIC', async () => {
    const bash = await generateCompletionScript(rootCommand, 'bash');

    expect(bash).toContain('TEXRA_COMPLETION_DYNAMIC');
    expect(bash).toContain('texra agents list --quiet');
    expect(bash).toContain('texra models list --quiet');
  });
});

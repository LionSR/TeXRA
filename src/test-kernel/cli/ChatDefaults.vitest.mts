import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { DEFAULT_AGENT_MODEL } from '@agent/core/AgentConfig';
import {
  BUILTIN_DEFAULT_CHAT_MODEL,
  resolveChatDefaults,
} from '../../../packages/cli/src/runtime/chatDefaults';

describe('CLI chat defaults', () => {
  it('uses the shared agent model as the built-in chat model', async () => {
    expect(BUILTIN_DEFAULT_CHAT_MODEL).toBe(DEFAULT_AGENT_MODEL);
    expect(MODEL_CONFIGS[BUILTIN_DEFAULT_CHAT_MODEL]).toBeDefined();

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: DEFAULT_AGENT_MODEL,
      source: 'builtin',
    });
  });
});

// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { MainViewPersistedStateSchema } from '@shared/schemas';
import { resolveSessionHintKey } from '@webview/frontend/sessionHints';

describe('sessionHints', () => {
  it('returns workflow for workflow mode', () => {
    const hintKey = resolveSessionHintKey({
      sessionType: 'workflow',
      toolUseAgent: 'orchestrator',
      toolUseAgentOptions: [],
    });

    assert.equal(hintKey, 'workflow');
  });

  it('returns toolUse for non-orchestrator tool-use agents', () => {
    const hintKey = resolveSessionHintKey({
      sessionType: 'toolUse',
      toolUseAgent: 'chat',
      toolUseAgentOptions: [{ value: 'chat', label: 'Chat' }],
    });

    assert.equal(hintKey, 'toolUse');
  });

  it('returns orchestrator for orchestrator tool-use agents', () => {
    const hintKey = resolveSessionHintKey({
      sessionType: 'toolUse',
      toolUseAgent: 'orchestrator',
      toolUseAgentOptions: [
        {
          value: 'orchestrator',
          label: 'Orchestrator',
          isOrchestrator: true,
        },
      ],
    });

    assert.equal(hintKey, 'orchestrator');
  });

  it('defaults dismissed session hints to visible', () => {
    const state = MainViewPersistedStateSchema.parse({});

    assert.deepEqual(state.dismissedSessionHints, {
      toolUse: false,
      workflow: false,
      orchestrator: false,
    });
  });
});

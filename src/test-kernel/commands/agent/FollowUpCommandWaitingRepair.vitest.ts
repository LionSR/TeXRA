// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deriveResumability: vi.fn(),
  handler: undefined as ((payload: unknown) => Promise<void>) | undefined,
  submitFollowUp: vi.fn(),
}));

vi.mock('@agent/storage/resumability', () => ({
  deriveResumability: mocks.deriveResumability,
}));
vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  presentFollowUpResult: vi.fn(),
  submitFollowUp: mocks.submitFollowUp,
}));
vi.mock('@commands/_shared/registerCommands', () => ({
  registerCommands: (
    _context: unknown,
    entries: Array<{
      id: string;
      handler: (payload: unknown) => Promise<void>;
    }>,
  ) => {
    mocks.handler = entries.find(
      ({ id }) => id === 'texra.sendFollowUp',
    )?.handler;
  },
}));

// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { registerFollowUpCommand } from '@commands/agent/followUpCommand';
import {
  buildRunDescriptor,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const STREAM = 'stream:concurrent-waiting-repair' as StreamTabId;
const EXECUTION = 'babcde' as ExecutionId;

describe('texra.sendFollowUp waiting repair admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handler = undefined;
    registerFollowUpCommand({ subscriptions: [] } as never);

    const session = defaultSession();
    session.snapshots.setRunDescriptor(
      buildRunDescriptor({
        streamId: STREAM,
        executionId: EXECUTION,
        agent: 'assistant',
        category: AgentCategory.ToolUse,
        kind: 'agent',
      }),
    );
    session.status.transition(STREAM, STREAM_PHASE.RUNNING, 'lifecycle');
    session.status.transition(STREAM, STREAM_PHASE.CANCELLED, 'user-stop');
  });

  it('admits two concurrent submissions in order after one repair probe', async () => {
    let release: (() => void) | undefined;
    mocks.deriveResumability.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ resumable: true, cause: 'interrupted-with-flow' });
        }),
    );
    const admitted: string[] = [];
    mocks.submitFollowUp.mockImplementation(
      async (_streamId: StreamTabId, input: { text: string }) => {
        admitted.push(input.text);
        return { status: 'sent' };
      },
    );

    const first = mocks.handler?.({ stream: STREAM, text: 'first' });
    const second = mocks.handler?.({ stream: STREAM, text: 'second' });

    expect(mocks.deriveResumability).toHaveBeenCalledTimes(1);
    expect(mocks.submitFollowUp).not.toHaveBeenCalled();

    release?.();
    await Promise.all([first, second]);

    expect(admitted).toEqual(['first', 'second']);
    expect(mocks.submitFollowUp).toHaveBeenCalledTimes(2);
    expect(defaultSession().status.get(STREAM)).toBe(STREAM_PHASE.WAITING);
  });
});

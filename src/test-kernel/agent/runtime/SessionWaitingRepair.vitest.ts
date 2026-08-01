// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  buildRunDescriptor,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

const resumabilityMocks = vi.hoisted(() => ({
  deriveResumability: vi.fn(),
}));

vi.mock('@agent/storage/resumability', () => ({
  deriveResumability: resumabilityMocks.deriveResumability,
}));

/**
 * `SessionHandle.repairWaitingIfResumable` is the re-homed lazy WAITING repair
 * that used to be a private helper in the VS Code `texra.sendFollowUp` command
 * (stage 7 item 1). It probes the same `deriveResumability` the startup pass
 * uses, so a follow-up for a resumable execution reaches the resume queue
 * rather than `no_session`.
 */
describe('SessionHandle.repairWaitingIfResumable', () => {
  setupPlatform();

  let caseCounter = 0;
  let session: SessionHandle;
  let streamId: StreamTabId;
  let executionId: ExecutionId;

  beforeEach(() => {
    const n = caseCounter++;
    resumabilityMocks.deriveResumability.mockReset();
    session = createTestSession();
    streamId = `stream:waiting-repair-${n}` as StreamTabId;
    executionId = `b${n.toString(16).padStart(5, '0')}` as ExecutionId;
    session.snapshots.setRunDescriptor(
      buildRunDescriptor({
        streamId,
        executionId,
        agent: 'assistant',
        category: AgentCategory.ToolUse,
        kind: 'agent',
      }),
    );
  });

  function seedCancelled(): void {
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');
    session.status.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');
  }

  it('restores a terminal stream to WAITING when its execution is resumable', async () => {
    seedCancelled();
    resumabilityMocks.deriveResumability.mockResolvedValue({
      resumable: true,
      cause: 'interrupted-with-flow',
    });

    await expect(session.repairWaitingIfResumable(streamId)).resolves.toBe(
      true,
    );

    expect(resumabilityMocks.deriveResumability).toHaveBeenCalledWith(
      executionId,
    );
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);
  });

  it('leaves the terminal phase alone when the execution is not resumable', async () => {
    seedCancelled();
    resumabilityMocks.deriveResumability.mockResolvedValue({
      resumable: false,
      cause: 'missing-flow',
    });

    await expect(session.repairWaitingIfResumable(streamId)).resolves.toBe(
      false,
    );

    expect(session.status.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
  });

  it('reports an already-waiting stream without reading resumability', async () => {
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');
    session.status.transition(streamId, STREAM_PHASE.WAITING, 'wait');

    await expect(session.repairWaitingIfResumable(streamId)).resolves.toBe(
      true,
    );

    expect(resumabilityMocks.deriveResumability).not.toHaveBeenCalled();
  });

  it('never repairs a live run', async () => {
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle');

    await expect(session.repairWaitingIfResumable(streamId)).resolves.toBe(
      false,
    );

    expect(resumabilityMocks.deriveResumability).not.toHaveBeenCalled();
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.RUNNING);
  });

  it('skips the probe for a stream with no recorded execution', async () => {
    const unknownStream = `${streamId}:unknown` as StreamTabId;

    await expect(session.repairWaitingIfResumable(unknownStream)).resolves.toBe(
      false,
    );

    expect(resumabilityMocks.deriveResumability).not.toHaveBeenCalled();
  });

  it('collapses concurrent probes for one stream onto the first', async () => {
    seedCancelled();
    let release: (() => void) | undefined;
    resumabilityMocks.deriveResumability.mockImplementation(
      async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ resumable: true, cause: 'interrupted-with-flow' });
        }),
    );

    const first = session.repairWaitingIfResumable(streamId);
    const second = session.repairWaitingIfResumable(streamId);

    expect(resumabilityMocks.deriveResumability).toHaveBeenCalledTimes(1);

    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(session.status.get(streamId)).toBe(STREAM_PHASE.WAITING);

    // The slot is released with the probe, so a later submission probes again.
    session.status.transition(streamId, STREAM_PHASE.RUNNING, 'resume');
    session.status.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');
    resumabilityMocks.deriveResumability.mockResolvedValue({
      resumable: false,
      cause: 'missing-flow',
    });
    await expect(session.repairWaitingIfResumable(streamId)).resolves.toBe(
      false,
    );
    expect(resumabilityMocks.deriveResumability).toHaveBeenCalledTimes(2);
  });
});

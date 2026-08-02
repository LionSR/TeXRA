// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import type {
  ToolUseRunShared,
  WaitExecResult,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import {
  testRunScope,
  toolUseRunShared,
  withTestRunContext,
} from '../progressTestUtils';
import { testModelCell } from '../modelCellTestUtils';

function buildServices(
  overrides: Partial<ToolUseServices<unknown>> = {},
): ToolUseServices<unknown> {
  return {
    runScope: testRunScope('test-stream'),
    logger: Object.assign(new TraceEmitter(), {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    modelCell: testModelCell({
      createUserFollowUpMessages: vi.fn(async (messages) => messages),
      addMediaToUserMessage: vi.fn(async () => []),
      capabilities: {},
    }) as never,
    fileService: { createLocation: vi.fn() } as never,
    onRoundFinalized: () => {},
    ...overrides,
  } as ToolUseServices<unknown>;
}

// WaitPrepResult isn't exported by ToolUseWaitNode.ts; this structurally
// satisfies it (checked at each node.post() call site below).
const PREP_RES = {
  lastResponse: undefined,
  afterError: false,
};

function userFollowUp(): WaitExecResult {
  return {
    kind: 'continue',
    followUps: [{ text: 'Do the thing.', origin: 'user' }],
  };
}

function failAppend(services: ToolUseServices<unknown>, message: string): void {
  (
    services.modelCell.handler.createUserFollowUpMessages as ReturnType<
      typeof vi.fn
    >
  ).mockRejectedValue(new Error(message));
}

function runPost(
  services: ToolUseServices<unknown>,
  execRes: WaitExecResult,
): Promise<unknown> {
  const node = new ToolUseWaitNode().setServices(services);
  const shared: ToolUseRunShared = toolUseRunShared();
  return withTestRunContext(services.runScope, () =>
    node.post(shared, PREP_RES, execRes),
  );
}

describe('ToolUseWaitNode follow-up transcript logging (regression: #7508 pattern on resume)', () => {
  it('logs a follow-up transcript row even when appendFollowUpAsUserMessage throws', async () => {
    // A failed follow-up append on resume (corrupt/oversized media, provider
    // validation error, ...) must still leave a record of what the user
    // asked for — otherwise that turn's transcript row silently vanishes.
    const services = buildServices();
    failAppend(services, 'follow-up append failed');

    await expect(runPost(services, userFollowUp())).rejects.toThrow(
      'follow-up append failed',
    );

    expect(services.logger.info).toHaveBeenCalledWith(
      'Do the thing.',
      expect.objectContaining({ messageType: expect.any(String) }),
    );
  });

  it('does not acknowledge consumption when the append throws', async () => {
    // The resume wrapper restores an unacknowledged drained batch; firing
    // onFollowUpConsumed before a failing append would mark the lost input
    // as consumed and drop it instead of replaying it on the next resume.
    const onFollowUpConsumed = vi.fn();
    const services = buildServices({ onFollowUpConsumed });
    failAppend(services, 'follow-up append failed');

    await expect(runPost(services, userFollowUp())).rejects.toThrow(
      'follow-up append failed',
    );

    expect(onFollowUpConsumed).not.toHaveBeenCalled();
  });

  it('acknowledges consumption after a successful append', async () => {
    const onFollowUpConsumed = vi.fn();
    const services = buildServices({ onFollowUpConsumed });

    await runPost(services, userFollowUp());

    expect(onFollowUpConsumed).toHaveBeenCalledOnce();
  });

  it('still logs exactly once per follow-up on the success path', async () => {
    const services = buildServices();

    await runPost(services, userFollowUp());

    expect(services.logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not log synthetic (idle-continuation) follow-ups', async () => {
    const services = buildServices();
    failAppend(services, 'boom');

    await expect(
      runPost(services, {
        kind: 'continue',
        followUps: [{ text: 'synthesized', origin: 'user' }],
        synthetic: true,
      }),
    ).rejects.toThrow('boom');

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});

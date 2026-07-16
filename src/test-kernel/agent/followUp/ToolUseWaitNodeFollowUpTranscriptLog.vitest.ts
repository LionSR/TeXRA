// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { ToolUseWaitNode } from '@agent/implementations/flows/tooluse/nodes/ToolUseWaitNode';
import type {
  ToolUseRunShared,
  WaitExecResult,
} from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import { toolUseRunShared, withTestRunContext } from '../progressTestUtils';

function buildServices(
  overrides: Partial<ToolUseServices<unknown>> = {},
): ToolUseServices<unknown> {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    modelHandler: {
      createUserFollowUpMessages: vi.fn(async (messages) => messages),
      addMediaToUserMessage: vi.fn(async () => []),
      capabilities: {},
    } as never,
    fileService: { createLocation: vi.fn() } as never,
    streamStatus: { transition: vi.fn() } as never,
    ...overrides,
  } as ToolUseServices<unknown>;
}

// WaitPrepResult isn't exported by ToolUseWaitNode.ts; this structurally
// satisfies it (checked at each node.post() call site below).
const PREP_RES = {
  lastResponse: undefined,
  touchedFiles: [] as string[],
  afterError: false,
};

describe('ToolUseWaitNode follow-up transcript logging (regression: #7508 pattern on resume)', () => {
  it('logs a follow-up transcript row even when appendFollowUpAsUserMessage throws', async () => {
    // A failed follow-up append on resume (corrupt/oversized media, provider
    // validation error, ...) must still leave a record of what the user
    // asked for — otherwise that turn's transcript row silently vanishes.
    const services = buildServices();
    (
      services.modelHandler.createUserFollowUpMessages as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error('follow-up append failed'));
    const node = new ToolUseWaitNode().setServices(services);
    const shared: ToolUseRunShared = toolUseRunShared();
    const runtimeHost = { emit: vi.fn() };
    const execRes: WaitExecResult = {
      kind: 'continue',
      followUps: [{ text: 'Do the thing.', origin: 'user' }],
    };

    await expect(
      withTestRunContext(runtimeHost, 'test-stream', () =>
        node.post(shared, PREP_RES, execRes),
      ),
    ).rejects.toThrow('follow-up append failed');

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
    (
      services.modelHandler.createUserFollowUpMessages as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error('follow-up append failed'));
    const node = new ToolUseWaitNode().setServices(services);
    const shared: ToolUseRunShared = toolUseRunShared();
    const runtimeHost = { emit: vi.fn() };
    const execRes: WaitExecResult = {
      kind: 'continue',
      followUps: [{ text: 'Do the thing.', origin: 'user' }],
    };

    await expect(
      withTestRunContext(runtimeHost, 'test-stream', () =>
        node.post(shared, PREP_RES, execRes),
      ),
    ).rejects.toThrow('follow-up append failed');

    expect(onFollowUpConsumed).not.toHaveBeenCalled();
  });

  it('acknowledges consumption after a successful append', async () => {
    const onFollowUpConsumed = vi.fn();
    const services = buildServices({ onFollowUpConsumed });
    const node = new ToolUseWaitNode().setServices(services);
    const shared: ToolUseRunShared = toolUseRunShared();
    const runtimeHost = { emit: vi.fn() };
    const execRes: WaitExecResult = {
      kind: 'continue',
      followUps: [{ text: 'Do the thing.', origin: 'user' }],
    };

    await withTestRunContext(runtimeHost, 'test-stream', () =>
      node.post(shared, PREP_RES, execRes),
    );

    expect(onFollowUpConsumed).toHaveBeenCalledOnce();
  });

  it('still logs exactly once per follow-up on the success path', async () => {
    const services = buildServices();
    const node = new ToolUseWaitNode().setServices(services);
    const shared: ToolUseRunShared = toolUseRunShared();
    const runtimeHost = { emit: vi.fn() };
    const execRes: WaitExecResult = {
      kind: 'continue',
      followUps: [{ text: 'Do the thing.', origin: 'user' }],
    };

    await withTestRunContext(runtimeHost, 'test-stream', () =>
      node.post(shared, PREP_RES, execRes),
    );

    expect(services.logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not log synthetic (idle-continuation) follow-ups', async () => {
    const services = buildServices();
    (
      services.modelHandler.createUserFollowUpMessages as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(new Error('boom'));
    const node = new ToolUseWaitNode().setServices(services);
    const shared: ToolUseRunShared = toolUseRunShared();
    const runtimeHost = { emit: vi.fn() };
    const execRes: WaitExecResult = {
      kind: 'continue',
      followUps: [{ text: 'synthesized', origin: 'user' }],
      synthetic: true,
    };

    await expect(
      withTestRunContext(runtimeHost, 'test-stream', () =>
        node.post(shared, PREP_RES, execRes),
      ),
    ).rejects.toThrow('boom');

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});

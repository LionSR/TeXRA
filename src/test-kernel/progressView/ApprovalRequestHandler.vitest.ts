// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - progress view backend
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';

interface TestRequest {
  readonly requestId: string;
  readonly streamId: string;
  readonly label: string;
}

type TestResult =
  | { readonly action: 'approve' }
  | { readonly action: 'cancel'; readonly cause?: string };

const request = (
  requestId: string,
  streamId: string,
  label = requestId,
): TestRequest => ({ requestId, streamId, label });

const cancellationResult = (cause?: string): TestResult => ({
  action: 'cancel',
  cause,
});

class TestApprovalRequestHandler extends ApprovalRequestHandler<
  TestRequest,
  'requestId',
  TestResult
> {
  stage(item: TestRequest): string {
    return this.stagePresentationForReplay(item);
  }
}

function createHandler(
  options: {
    canSend?: () => boolean;
    sendShow?: (item: TestRequest) => void;
    sendDismiss?: (id: string) => void;
  } = {},
) {
  const sendShow = vi.fn(options.sendShow ?? (() => undefined));
  const sendDismiss = vi.fn(options.sendDismiss ?? (() => undefined));
  const handler = new TestApprovalRequestHandler(
    'requestId',
    sendShow,
    sendDismiss,
    options.canSend ?? (() => true),
  );
  return { handler, sendDismiss, sendShow };
}

describe('ApprovalRequestHandler', () => {
  it('removes an interaction before its typed completion and settles once', async () => {
    const sendDismiss = vi.fn((id: string) => {
      expect(handler.get(id)).toBeUndefined();
      expect(handler.complete(id, { action: 'approve' })).toBe(false);
    });
    const handler = new ApprovalRequestHandler<
      TestRequest,
      'requestId',
      TestResult
    >('requestId', vi.fn(), sendDismiss, () => true);
    const result = handler.request(request('request-a', 'stream-a'), {
      cancellationResult,
    });

    expect(handler.complete('request-a', { action: 'approve' })).toBe(true);
    expect(handler.complete('request-a', { action: 'approve' })).toBe(false);

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(sendDismiss).toHaveBeenCalledOnce();
  });

  it('cancels a duplicate interaction before presenting its replacement', async () => {
    const events: string[] = [];
    const { handler } = createHandler({
      sendShow: (item) => events.push(`show:${item.label}`),
      sendDismiss: (id) => events.push(`dismiss:${id}`),
    });
    const first = handler.request(request('same-id', 'stream-a', 'first'), {
      cancellationResult: (cause) => {
        events.push(`cancel:${cause}`);
        return cancellationResult(cause);
      },
    });

    const replacement = handler.request(
      request('same-id', 'stream-a', 'replacement'),
      { cancellationResult },
    );

    await expect(first).resolves.toEqual({
      action: 'cancel',
      cause: 'Approval request was replaced.',
    });
    expect(events).toEqual([
      'show:first',
      'cancel:Approval request was replaced.',
      'dismiss:same-id',
      'show:replacement',
    ]);
    expect(handler.get('same-id')?.label).toBe('replacement');
    expect(handler.complete('same-id', { action: 'approve' })).toBe(true);
    await expect(replacement).resolves.toEqual({ action: 'approve' });
  });

  it('keeps presentation dismissal distinct from interaction completion', async () => {
    const { handler, sendDismiss } = createHandler();
    handler.show(request('presentation', 'stream-a'));

    expect(handler.complete('presentation', { action: 'approve' })).toBe(false);
    expect(handler.dismiss('presentation')).toBe(true);
    expect(handler.dismiss('presentation')).toBe(false);

    const result = handler.request(request('interaction', 'stream-a'), {
      cancellationResult,
    });
    expect(handler.dismiss('interaction')).toBe(false);
    expect(handler.complete('interaction', { action: 'approve' })).toBe(true);

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(sendDismiss.mock.calls).toEqual([['presentation'], ['interaction']]);
  });

  it('rolls back presentation and interaction state when delivery throws', async () => {
    const sendShow = vi.fn(() => {
      throw new Error('presentation failed');
    });
    const { handler, sendDismiss } = createHandler({ sendShow });

    expect(() => handler.show(request('presentation', 'stream-a'))).toThrow(
      'presentation failed',
    );
    await expect(
      handler.request(request('interaction', 'stream-a'), {
        cancellationResult,
      }),
    ).rejects.toThrow('presentation failed');

    expect(handler.get('presentation')).toBeUndefined();
    expect(handler.get('interaction')).toBeUndefined();
    expect(handler.hasPendingForStream('stream-a')).toBe(false);
    sendShow.mockClear();
    handler.replay();
    expect(sendShow).not.toHaveBeenCalled();
    expect(sendDismiss).not.toHaveBeenCalled();
  });

  it('settles an interaction before staging its durable presentation', async () => {
    const { handler, sendDismiss, sendShow } = createHandler();
    const result = handler.request(request('same-id', 'stream-a', 'live'), {
      cancellationResult,
    });

    expect(handler.stage(request('same-id', 'stream-a', 'durable'))).toBe(
      'same-id',
    );

    await expect(result).resolves.toEqual({
      action: 'cancel',
      cause: 'Approval request was replaced.',
    });
    expect(handler.get('same-id')?.label).toBe('durable');
    expect(sendDismiss).not.toHaveBeenCalled();
    handler.replay();
    expect(handler.get('same-id')?.label).toBe('durable');
    expect(sendShow.mock.calls.map(([item]) => item.label)).toEqual([
      'live',
      'durable',
    ]);
  });

  it('replays retained entries once to each newly ready target', async () => {
    let canSend = false;
    const { handler, sendShow } = createHandler({ canSend: () => canSend });
    const result = handler.request(request('request-a', 'stream-a'), {
      cancellationResult,
    });

    expect(sendShow).not.toHaveBeenCalled();
    canSend = true;
    handler.replay();
    expect(sendShow).toHaveBeenCalledTimes(1);
    handler.replay();
    expect(sendShow).toHaveBeenCalledTimes(2);

    expect(handler.complete('request-a', { action: 'approve' })).toBe(true);
    await expect(result).resolves.toEqual({ action: 'approve' });
    handler.replay();
    expect(sendShow).toHaveBeenCalledTimes(2);
  });

  it('cancels only interactions matching both stream and cancellation scope', async () => {
    const { handler } = createHandler();
    const targetScope = {};
    const otherScope = {};
    const target = handler.request(request('target', 'stream-a'), {
      cancellationScope: targetScope,
      cancellationResult,
    });
    const wrongScope = handler.request(request('wrong-scope', 'stream-a'), {
      cancellationScope: otherScope,
      cancellationResult,
    });
    const wrongStream = handler.request(request('wrong-stream', 'stream-b'), {
      cancellationScope: targetScope,
      cancellationResult,
    });

    expect(
      handler.cancelWhere(
        (item, scope) => item.streamId === 'stream-a' && scope === targetScope,
        'Scoped cleanup.',
      ),
    ).toBe(1);
    await expect(target).resolves.toEqual({
      action: 'cancel',
      cause: 'Scoped cleanup.',
    });
    expect(handler.get('wrong-scope')).toBeDefined();
    expect(handler.get('wrong-stream')).toBeDefined();

    handler.clear();
    await expect(wrongScope).resolves.toEqual({
      action: 'cancel',
      cause: undefined,
    });
    await expect(wrongStream).resolves.toEqual({
      action: 'cancel',
      cause: undefined,
    });
  });

  it('completes every matching interaction without touching peers', async () => {
    const { handler } = createHandler();
    const first = handler.request(request('first', 'stream-a'), {
      cancellationResult,
    });
    const second = handler.request(request('second', 'stream-a'), {
      cancellationResult,
    });
    const peer = handler.request(request('peer', 'stream-b'), {
      cancellationResult,
    });

    expect(
      handler.completeWhere((item) => item.streamId === 'stream-a', {
        action: 'approve',
      }),
    ).toBe(2);
    await expect(first).resolves.toEqual({ action: 'approve' });
    await expect(second).resolves.toEqual({ action: 'approve' });
    expect(handler.get('peer')).toBeDefined();

    expect(handler.complete('peer', { action: 'approve' })).toBe(true);
    await expect(peer).resolves.toEqual({ action: 'approve' });
  });

  it('releases and clears interactions without orphaning their promises', async () => {
    const { handler, sendDismiss } = createHandler();
    const released = handler.request(request('released', 'stream-a'), {
      cancellationResult,
    });
    handler.show(request('released-presentation', 'stream-a'));
    const retained = handler.request(request('retained', 'stream-b'), {
      cancellationResult,
    });
    handler.show(request('retained-presentation', 'stream-b'));

    handler.releaseForStream('stream-a');
    await expect(released).resolves.toEqual({
      action: 'cancel',
      cause: undefined,
    });
    expect(handler.get('released')).toBeUndefined();
    expect(handler.get('released-presentation')).toBeUndefined();
    expect(handler.get('retained')).toBeDefined();

    handler.clear();
    await expect(retained).resolves.toEqual({
      action: 'cancel',
      cause: undefined,
    });
    expect(handler.get('retained')).toBeUndefined();
    expect(handler.get('retained-presentation')).toBeUndefined();
    expect(handler.hasPendingForStream('stream-b')).toBe(false);
    expect(sendDismiss).not.toHaveBeenCalled();
  });

  it('isolates identical ids owned by different request kinds', async () => {
    const first = createHandler();
    const second = createHandler();
    const firstResult = first.handler.request(
      request('shared-id', 'stream-a', 'first-kind'),
      { cancellationResult },
    );
    const secondResult = second.handler.request(
      request('shared-id', 'stream-a', 'second-kind'),
      { cancellationResult },
    );

    expect(first.handler.complete('shared-id', { action: 'approve' })).toBe(
      true,
    );
    await expect(firstResult).resolves.toEqual({ action: 'approve' });
    expect(second.handler.get('shared-id')?.label).toBe('second-kind');

    expect(second.handler.complete('shared-id', { action: 'approve' })).toBe(
      true,
    );
    await expect(secondResult).resolves.toEqual({ action: 'approve' });
    expect(first.sendDismiss).toHaveBeenCalledWith('shared-id');
    expect(second.sendDismiss).toHaveBeenCalledWith('shared-id');
  });
});

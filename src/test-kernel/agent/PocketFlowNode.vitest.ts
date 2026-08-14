import { AbortError } from 'p-retry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseNode, Node } from '@agent/node';
import * as logger from '@logger/logUtils';

class TestNode extends BaseNode<Record<string, never>> {}

describe('BaseNode.getNextNode', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['complete', 'finalize'] as const)(
    "returns undefined silently for the terminal action '%s' when unregistered",
    (action) => {
      const node = new TestNode();
      // Register an unrelated successor so `_successors.size > 0`, which is
      // the branch that would otherwise trigger the "Flow ends" warning.
      node.on('default', new TestNode());

      expect(node.getNextNode(action)).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it('warns when a non-terminal unregistered action falls through', () => {
    const node = new TestNode();
    node.on('default', new TestNode());

    expect(node.getNextNode('unregistered-action')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'PocketFlow',
      expect.stringContaining(
        "Flow ends: 'unregistered-action' not found in [default]",
      ),
    );
  });

  it('does not warn when no successors are registered at all', () => {
    const node = new TestNode();

    expect(node.getNextNode('anything')).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

type ScriptedOutcome =
  Error | string | (() => Promise<string>) | { thrown: unknown };

/** `[failure 1, …, failure n]` for scripted exec outcomes. */
function failureSequence(count: number): Error[] {
  return Array.from({ length: count }, (_, i) => new Error(`failure ${i + 1}`));
}

class ScriptedRetryNode extends Node {
  calls = 0;
  prompts = 0;
  fallbackError?: Error;
  readonly events: string[] = [];
  readonly promptErrors: Error[] = [];

  constructor(
    maxRetries: number,
    private readonly outcomes: ScriptedOutcome[],
    private readonly approvals: boolean[],
    private readonly autoRetry = true,
    private readonly onPrompt?: () => void,
    private readonly onExec?: (call: number) => void,
  ) {
    super(maxRetries, 0);
  }

  override async exec(): Promise<string> {
    this.calls += 1;
    this.events.push(`exec:${this.calls}`);
    this.onExec?.(this.calls);
    const outcome = this.outcomes[this.calls - 1];
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'function') return await outcome();
    if (typeof outcome === 'object') throw outcome.thrown;
    return outcome;
  }

  override shouldAutoRetry(): boolean {
    return this.autoRetry;
  }

  override async retryPrompt(
    _prepRes: unknown,
    error: Error,
  ): Promise<boolean> {
    this.prompts += 1;
    this.promptErrors.push(error);
    this.events.push(`prompt:${error.message}`);
    this.onPrompt?.();
    return this.approvals[this.prompts - 1] ?? false;
  }

  override async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<string> {
    this.fallbackError = error;
    this.events.push(`fallback:${error.message}`);
    return 'fallback';
  }
}

describe('Node manual retry', () => {
  it('grants one attempt after an exhausted automatic retry batch', async () => {
    const node = new ScriptedRetryNode(3, failureSequence(4), [true, false]);

    await expect(node._exec(undefined)).resolves.toBe('fallback');
    expect(node.calls).toBe(4);
    expect(node.events).toEqual([
      'exec:1',
      'exec:2',
      'exec:3',
      'prompt:failure 3',
      'exec:4',
      'prompt:failure 4',
      'fallback:failure 4',
    ]);
    expect(node.fallbackError?.message).toBe('failure 4');
  });

  it('grants one attempt for each repeated approval', async () => {
    const node = new ScriptedRetryNode(2, failureSequence(4), [
      true,
      true,
      false,
    ]);

    await expect(node._exec(undefined)).resolves.toBe('fallback');
    expect(node.calls).toBe(4);
    expect(node.prompts).toBe(3);
    expect(node.events).toEqual([
      'exec:1',
      'exec:2',
      'prompt:failure 2',
      'exec:3',
      'prompt:failure 3',
      'exec:4',
      'prompt:failure 4',
      'fallback:failure 4',
    ]);
  });

  it('skips the remaining automatic batch when shouldAutoRetry is false', async () => {
    const node = new ScriptedRetryNode(
      3,
      [new Error('not automatic'), 'completed'],
      [true],
      false,
    );

    await expect(node._exec(undefined)).resolves.toBe('completed');
    expect(node.events).toEqual(['exec:1', 'prompt:not automatic', 'exec:2']);
  });

  it('returns success from the single approved attempt', async () => {
    const node = new ScriptedRetryNode(
      3,
      [...failureSequence(3), 'completed'],
      [true],
    );

    await expect(node._exec(undefined)).resolves.toBe('completed');
    expect(node.calls).toBe(4);
    expect(node.prompts).toBe(1);
  });

  it('does not execute or prompt again when cancelled while awaiting approval', async () => {
    const controller = new AbortController();
    const node = new ScriptedRetryNode(
      1,
      [new Error('original failure')],
      [true],
      true,
      () => controller.abort(),
    );
    node.signal = controller.signal;

    await expect(node._exec(undefined)).resolves.toBe('fallback');
    expect(node.events).toEqual([
      'exec:1',
      'prompt:original failure',
      'fallback:original failure',
    ]);
    expect(node.fallbackError?.message).toBe('original failure');
  });

  it('does not prompt again when cancelled during an approved attempt', async () => {
    const controller = new AbortController();
    const node = new ScriptedRetryNode(
      1,
      [new Error('original failure'), new Error('approved failure')],
      [true],
      true,
      undefined,
      (call) => {
        if (call === 2) controller.abort();
      },
    );
    node.signal = controller.signal;

    await expect(node._exec(undefined)).resolves.toBe('fallback');
    expect(node.events).toEqual([
      'exec:1',
      'prompt:original failure',
      'exec:2',
      'fallback:approved failure',
    ]);
    expect(node.fallbackError?.message).toBe('approved failure');
  });

  it('falls back when cancellation wins after an approved attempt resolves', async () => {
    const controller = new AbortController();
    let resolveApprovedAttempt!: (value: string) => void;
    const approvedAttempt = new Promise<string>((resolve) => {
      resolveApprovedAttempt = resolve;
    });
    const originalError = new Error('original failure');
    const node = new ScriptedRetryNode(
      1,
      [originalError, () => approvedAttempt],
      [true],
    );
    node.signal = controller.signal;

    const result = node._exec(undefined);
    await vi.waitFor(() => expect(node.calls).toBe(2));
    controller.abort();
    resolveApprovedAttempt('late success');

    await expect(result).resolves.toBe('fallback');
    expect(node.events).toEqual([
      'exec:1',
      'prompt:original failure',
      'exec:2',
      'fallback:original failure',
    ]);
    expect(node.fallbackError).toBe(originalError);
  });

  it('unwraps AbortError from an approved attempt before prompting again', async () => {
    const originalError = new Error('stop retrying');
    const node = new ScriptedRetryNode(
      1,
      [new Error('initial failure'), new AbortError(originalError)],
      [true, false],
    );

    await expect(node._exec(undefined)).resolves.toBe('fallback');
    expect(node.promptErrors[1]).toBe(originalError);
    expect(node.fallbackError).toBe(originalError);
  });

  it('normalizes a non-Error thrown by an approved attempt', async () => {
    const node = new ScriptedRetryNode(
      1,
      [new Error('initial failure'), { thrown: 'raw failure' }],
      [true, false],
    );

    await expect(node._exec(undefined)).resolves.toBe('fallback');
    expect(node.promptErrors[1]).toBeInstanceOf(TypeError);
    expect(node.promptErrors[1]?.message).toBe(
      'Non-error was thrown: "raw failure". You should only throw errors.',
    );
    expect(node.fallbackError).toBe(node.promptErrors[1]);
  });

  it('continues beyond the former 100-approval ceiling one attempt at a time', async () => {
    const node = new ScriptedRetryNode(
      1,
      [
        ...Array.from({ length: 101 }, () => new Error('temporary failure')),
        'completed',
      ],
      Array.from({ length: 101 }, () => true),
    );

    await expect(node._exec(undefined)).resolves.toBe('completed');
    expect(node.calls).toBe(102);
    expect(node.prompts).toBe(101);
  });
});

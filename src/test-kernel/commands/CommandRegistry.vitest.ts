// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports
import {
  definedHandler,
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';

interface TestActions {
  noop(): void;
  packed(input: { inputFile: string; agent: string }): void;
}

function makeActions(): TestActions {
  return { noop: vi.fn(), packed: vi.fn() };
}

const PackArgs = z.tuple([
  z.object({
    inputFile: z.string().min(1),
    agent: z.string().min(1),
  }),
]);

const packRegistry = {
  'test.pack': definedHandler<TestActions, z.infer<typeof PackArgs>>(
    PackArgs,
    (a, args) => {
      a.packed(args);
      return true;
    },
  ),
};

describe('shared command registry', () => {
  it('dispatches legacy no-arg handlers', () => {
    const actions = makeActions();
    const registry = {
      'test.noop': (a: TestActions) => {
        a.noop();
        return true;
      },
    } satisfies Record<'test.noop', CommandHandler<TestActions>>;

    expect(dispatchCommandFromRegistry('test.noop', registry, actions)).toBe(
      true,
    );
    expect(actions.noop).toHaveBeenCalledOnce();
  });

  it('reports unhandled ids without throwing', () => {
    const onFailure = vi.fn();
    const result = dispatchCommandFromRegistry(
      'test.missing',
      {} as Partial<Record<'test.missing', CommandHandler<TestActions>>>,
      makeActions(),
      onFailure,
    );
    expect(result).toBe(false);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      kind: 'unhandled',
      id: 'test.missing',
    });
  });

  it('parses raw args through the typed handler schema', () => {
    const actions = makeActions();

    expect(
      dispatchCommandFromRegistry(
        'test.pack',
        packRegistry,
        actions,
        undefined,
        { inputFile: 'main.tex', agent: 'editor' },
      ),
    ).toBe(true);
    expect(actions.packed).toHaveBeenCalledExactlyOnceWith({
      inputFile: 'main.tex',
      agent: 'editor',
    });
  });

  it('reports schema-failed args distinctly from unhandled ids', () => {
    const actions = makeActions();
    const onFailure = vi.fn();

    expect(
      dispatchCommandFromRegistry(
        'test.pack',
        packRegistry,
        actions,
        onFailure,
        { inputFile: '', agent: 'editor' },
      ),
    ).toBe(false);
    expect(actions.packed).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'invalidArguments',
        id: 'test.pack',
        error: expect.any(z.ZodError),
      }),
    );
  });
});

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import type { ModelOptionData } from '@shared/schemas';
import { fakeProcessServices, hostStores } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  readModelOptions: vi.fn<() => Effect.Effect<readonly ModelOptionData[]>>(),
}));

vi.mock('@model/computeModelOptions', () => ({
  // A case seeds picker rows; the read answers each row's verdict.
  readModelOptions: () =>
    Effect.map(mocks.readModelOptions(), (rows) =>
      rows.map(({ value, availability }) => ({
        model: value,
        availability: availability ?? 'provider-key',
      })),
    ),
}));

const { selectAvailableDelegationModel } =
  await import('@tools/delegation/delegationAvailability');

function model(
  value: string,
  overrides: Partial<ModelOptionData> = {},
): ModelOptionData {
  return {
    value,
    label: value,
    ...overrides,
  };
}

describe('delegation model availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect(
    'rejects an explicitly requested model that is not currently available',
    () =>
      Effect.gen(function* () {
        mocks.readModelOptions.mockReturnValue(
          Effect.succeed([
            model('anthropic/claude-sonnet-5-5'),
            model('anthropic/claude-opus-5-5', { availability: 'retired' }),
            model('deepseek/deepseek-v4-flash', {
              availability: 'provider-key',
            }),
          ]),
        );

        const failure = yield* Effect.flip(
          selectAvailableDelegationModel({
            requestedModel: 'anthropic/claude-opus-5-5',
            parentModel: 'anthropic/claude-sonnet-5-5',
            settings: hostStores(),
          }),
        );

        expect(failure.message).toContain(
          'Model "anthropic/claude-opus-5-5" is not currently available for delegation with the currently configured model access. Available models: anthropic/claude-sonnet-5-5, deepseek/deepseek-v4-flash.',
        );
      }).pipe(Effect.provide(fakeProcessServices())),
  );

  it.effect('uses the parent model only when it is available', () =>
    Effect.gen(function* () {
      mocks.readModelOptions.mockReturnValue(
        Effect.succeed([
          model('deepseek/deepseek-v4-flash'),
          model('anthropic/claude-sonnet-5-5'),
        ]),
      );

      expect(
        yield* selectAvailableDelegationModel({
          parentModel: 'anthropic/claude-sonnet-5-5',
          settings: hostStores(),
        }),
      ).toBe('anthropic/claude-sonnet-5-5');

      expect(
        yield* selectAvailableDelegationModel({
          parentModel: 'anthropic/claude-opus-5-5',
          settings: hostStores(),
        }),
      ).toBe('deepseek/deepseek-v4-flash');
    }).pipe(Effect.provide(fakeProcessServices())),
  );
});

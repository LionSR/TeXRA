import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import type { ModelOptionData } from '@shared/schemas';
import { fakeProcessServices, hostStores } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  readModelAvailabilityInputs: vi.fn(),
}));

vi.mock('@model/computeModelOptions', () => ({
  readModelAvailabilityInputs: mocks.readModelAvailabilityInputs,
  // Availability is read once and finished purely, so a case seeds the option
  // rows on the read and the pure finisher hands them straight back.
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
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
        mocks.readModelAvailabilityInputs.mockReturnValue(
          Effect.succeed([
            model('anthropic/claude-sonnet-4-6'),
            model('anthropic/claude-opus-4-8', { availability: 'retired' }),
            model('deepseek/deepseek-v4-flash', {
              availability: 'provider-key',
            }),
          ]),
        );

        const failure = yield* Effect.flip(
          selectAvailableDelegationModel({
            requestedModel: 'anthropic/claude-opus-4-8',
            parentModel: 'anthropic/claude-sonnet-4-6',
            settings: hostStores(),
          }),
        );

        expect(failure.message).toContain(
          'Model "anthropic/claude-opus-4-8" is not currently available for delegation with the currently configured model access. Available models: anthropic/claude-sonnet-4-6, deepseek/deepseek-v4-flash.',
        );
      }).pipe(Effect.provide(fakeProcessServices())),
  );

  it.effect('uses the parent model only when it is available', () =>
    Effect.gen(function* () {
      mocks.readModelAvailabilityInputs.mockReturnValue(
        Effect.succeed([
          model('deepseek/deepseek-v4-flash'),
          model('anthropic/claude-sonnet-4-6'),
        ]),
      );

      expect(
        yield* selectAvailableDelegationModel({
          parentModel: 'anthropic/claude-sonnet-4-6',
          settings: hostStores(),
        }),
      ).toBe('anthropic/claude-sonnet-4-6');

      expect(
        yield* selectAvailableDelegationModel({
          parentModel: 'anthropic/claude-opus-4-8',
          settings: hostStores(),
        }),
      ).toBe('deepseek/deepseek-v4-flash');
    }).pipe(Effect.provide(fakeProcessServices())),
  );
});

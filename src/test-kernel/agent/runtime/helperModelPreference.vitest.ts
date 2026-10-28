import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { applyHelperModelPreference } from '@agent/runtime/helperModelName';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/defaultModels';
import {
  fakeProcessServices,
  installedHost,
} from '@test/support/setupPlatform';

describe('applyHelperModelPreference', () => {
  // No credential is stored, so the helper model cannot run: the launch keeps
  // the model the user selected rather than failing on the helper.
  it.effect(
    'falls back to the selected model when the helper model is unavailable',
    () =>
      Effect.gen(function* () {
        const selected = 'anthropic/claude-sonnet-4-6';
        expect(DEFAULT_HELPER_MODEL).not.toBe(selected);
        const config = {
          agent: 'latexFixer',
          model: selected,
        } as unknown as AgentConfig;

        const result = yield* applyHelperModelPreference(
          config,
          installedHost().roots,
        );

        expect(result.model).toBe(selected);
      }).pipe(Effect.provide(fakeProcessServices())),
  );
});

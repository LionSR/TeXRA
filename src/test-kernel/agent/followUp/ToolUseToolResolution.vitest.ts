import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import { Effect } from 'effect';

import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ToolDefinition } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { toolRegistryLayer } from '@tools/registry';

const logger = { warn: () => {} };

function toolDefs(names: readonly string[]): ToolDefinition[] {
  return names.map((name) => ({ name }));
}

describe('tool-use tool resolution', () => {
  function resolveNames(
    names: readonly string[],
    options: {
      approvalPromptsUnavailable: boolean;
      host?: 'cli' | 'desktop' | 'extension' | undefined;
      injectTools?: boolean;
    },
  ) {
    return resolveAgentTools({
      tools: toolDefs(names),
      logger,
      injectTools: false,
      stores: hostStores(),
      workspaceRoot: undefined,
      host: 'extension',
      ...options,
    }).pipe(
      Effect.map(({ definitions }) => definitions.map((tool) => tool.name)),
      // The delegation-annotation availability read yields `LanguageModel`;
      // this host has no editor models.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
      Effect.provide(toolRegistryLayer),
    );
  }

  it.effect(
    'filters approval-gated tools when approval prompts are unavailable',
    () =>
      Effect.gen(function* () {
        const names = [
          'ask_user_question',
          'bash',
          'delegate_agent',
          'grep',
          'inquiry',
          'plan',
          'send_to_terminal',
          'update_config',
          'wolfram',
          'write_file',
        ];

        expect(
          yield* resolveNames(names, { approvalPromptsUnavailable: true }),
        ).toEqual(['grep']);
      }),
  );

  it.effect(
    'filters host-excluded tools without hiding other approval-gated tools',
    () =>
      Effect.gen(function* () {
        expect(
          yield* resolveNames(
            ['ask_user_question', 'bash', 'grep', 'inquiry', 'write_file'],
            {
              approvalPromptsUnavailable: false,
              host: 'cli',
            },
          ),
        ).toEqual(['ask_user_question', 'bash', 'grep', 'write_file']);
        // A process no composition root named withholds every host-bound
        // tool rather than guessing it is the extension.
        expect(
          yield* resolveNames(['bash', 'inquiry', 'send_to_terminal'], {
            approvalPromptsUnavailable: false,
            host: undefined,
          }),
        ).toEqual(['bash']);
      }),
  );

  it.effect(
    'drops the workflow script tool when its dashboard switch is disabled',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: {
              [GlobalStateKey.DISABLED_TOOLS]: ['workflow-script'],
            },
          }),
        );

        expect(
          yield* resolveNames(['bash', 'delegate_multi_agents'], {
            approvalPromptsUnavailable: false,
          }),
        ).toEqual(['bash']);
        // The host this case installs is torn down however the case ends.
      }).pipe(Effect.ensuring(Effect.promise(() => installPlatform()))),
  );

  it.effect(
    'filters injected approval-gated tools when approval prompts are unavailable',
    () =>
      Effect.gen(function* () {
        // Memory and goal are on by default, so both are injected; `plan` is
        // approval-gated.
        expect(
          yield* resolveNames(['grep'], {
            approvalPromptsUnavailable: true,
            injectTools: true,
          }),
        ).toEqual(['grep', 'memory']);
      }),
  );
});

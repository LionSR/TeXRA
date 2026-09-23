import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';
import { Effect } from 'effect';

import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ToolDefinition } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';
import { getDefaultToolRegistry } from '@tools/registry';

const logger = { warn: () => {} };

function toolDefs(names: readonly string[]): ToolDefinition[] {
  return names.map((name) => ({ name }));
}

describe('tool-use tool resolution', () => {
  // The injections this run resolves with: the production shape, built here
  // rather than taken from the process list.
  let injected: readonly {
    readonly toolName: 'update_config';
    readonly shouldInject: () => Effect.Effect<boolean>;
  }[] = [];
  const toolInjections = { list: () => injected };

  beforeEach(() => {
    injected = [];
  });

  function resolveNames(
    names: readonly string[],
    options: {
      approvalPromptsUnavailable: boolean;
      runtimeUnavailableTools?: readonly string[];
    },
  ) {
    return resolveAgentTools({
      tools: toolDefs(names),
      registry: getDefaultToolRegistry(),
      logger,
      toolInjections,
      stores: hostStores(),
      workspaceRoot: undefined,
      ...options,
    }).pipe(
      Effect.map((tools) => tools.map((tool) => tool.name)),
      // The delegation-annotation availability read yields `LanguageModel`;
      // this host has no editor models.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    );
  }

  function resolveDiagnostics(runtimeUnavailableTools: readonly string[]) {
    const diagnostics = new DiagnosticsTool();
    const registry = new MapToolRegistry({ diagnostics });
    return resolveAgentTools({
      tools: [diagnostics.definition],
      registry,
      logger,
      toolInjections,
      stores: hostStores(),
      workspaceRoot: undefined,
      runtimeUnavailableTools,
      approvalPromptsUnavailable: false,
    }).pipe(
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
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
    'filters runtime-unavailable tools without hiding other approval-gated tools',
    () =>
      Effect.gen(function* () {
        expect(
          yield* resolveNames(
            ['ask_user_question', 'bash', 'grep', 'inquiry', 'write_file'],
            {
              approvalPromptsUnavailable: false,
              runtimeUnavailableTools: ['inquiry'],
            },
          ),
        ).toEqual(['ask_user_question', 'bash', 'grep', 'write_file']);
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
        injected = [
          {
            toolName: 'update_config',
            shouldInject: () => Effect.succeed(true),
          },
        ];

        expect(
          yield* resolveNames(['grep'], { approvalPromptsUnavailable: true }),
        ).toEqual(['grep']);
      }),
  );
});

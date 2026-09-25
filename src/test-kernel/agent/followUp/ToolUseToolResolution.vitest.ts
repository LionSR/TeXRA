import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import { Effect, Exit, Layer, Scope } from 'effect';

import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ToolDefinition } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import type { CompositionKey } from '@tools/compositions';
import { toolTableLayer } from '@tools/compositions';
import { toolRegistryLayer } from '@tools/registry';
import { toolTable } from '@tools/toolTable';
import { setToolEnabled } from '@utils/config/constants';

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
      Effect.scoped,
      // The delegation-annotation availability read yields `LanguageModel`;
      // this host has no editor models.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
      Effect.provide(toolRegistryLayer.pipe(Layer.provide(nodePlatformLayer))),
      Effect.provide(nodeSpawnerLayer),
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

  it.effect(
    "a child only narrows its parent: it passes the parent's gates and cannot name a plugin the parent lacks",
    () =>
      Effect.gen(function* () {
        const resolve = (
          names: readonly string[],
          approvalPromptsUnavailable: boolean,
          inherited?: CompositionKey,
        ) =>
          resolveAgentTools({
            tools: toolDefs(names),
            logger,
            injectTools: false,
            stores: hostStores(),
            workspaceRoot: undefined,
            host: 'extension',
            approvalPromptsUnavailable,
            inherited,
          });
        const parent = yield* resolve(['grep'], true);
        // The child's own host could answer approvals; its parent's could not.
        const child = yield* resolve(
          ['bash', 'grep', 'write_file'],
          false,
          parent.pinned.key,
        );
        expect(child.definitions.map((tool) => tool.name)).toEqual(['grep']);
        const refused = yield* Effect.flip(
          resolve(['grep', 'mcp__candidate__*'], false, parent.pinned.key),
        );
        expect(refused.message).toContain('mcp__candidate__*');
        expect(refused.message).toContain('MCP server "candidate"');
      }).pipe(
        Effect.scoped,
        Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
        Effect.provide(
          toolRegistryLayer.pipe(Layer.provide(nodePlatformLayer)),
        ),
        Effect.provide(nodeSpawnerLayer),
      ),
  );

  it.effect(
    'a run keeps its composition across a switch change, and its plugin layer closes with the last run holding it',
    () => {
      const events: string[] = [];
      // One plugin whose layer records its lifetime.
      const table = toolTable(
        {
          zotero: {
            zotero_search: {
              definition: { name: 'zotero_search' },
              call: () => Effect.die('not called'),
            },
          },
        },
        {
          zotero: Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => events.push('open')),
              () => Effect.sync(() => events.push('close')),
            ),
          ),
        },
      );
      return Effect.gen(function* () {
        const stores = hostStores();
        const resolve = (inherited?: CompositionKey) =>
          resolveAgentTools({
            tools: toolDefs(['zotero_search']),
            logger,
            injectTools: false,
            stores,
            workspaceRoot: undefined,
            host: 'extension',
            inherited,
          }).pipe(
            Effect.provide(
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
            ),
            Effect.provide(nodeSpawnerLayer),
          );
        const names = (resolved: Effect.Success<ReturnType<typeof resolve>>) =>
          resolved.definitions.map((tool) => tool.name);

        const parentScope = yield* Scope.make();
        const parent = yield* Scope.provide(resolve(), parentScope);
        expect(names(parent)).toEqual(['zotero_search']);
        expect(events).toEqual(['open']);

        yield* setToolEnabled('zotero', false, stores.globalState);
        // A new run gets the new composition; a child joins its parent's.
        const laterScope = yield* Scope.make();
        const later = yield* Scope.provide(resolve(), laterScope);
        expect(names(later)).toEqual([]);
        expect(later.pinned.key.hash).not.toBe(parent.pinned.key.hash);
        const childScope = yield* Scope.make();
        const child = yield* Scope.provide(
          resolve(parent.pinned.key),
          childScope,
        );
        expect(names(child)).toEqual(['zotero_search']);

        yield* Scope.close(parentScope, Exit.void);
        expect(events).toEqual(['open']);
        yield* Scope.close(childScope, Exit.void);
        expect(events).toEqual(['open', 'close']);
        yield* Scope.close(laterScope, Exit.void);
      }).pipe(
        Effect.provide(toolTableLayer(table)),
        Effect.provide(nodeSpawnerLayer),
        Effect.ensuring(Effect.promise(() => installPlatform())),
      );
    },
  );
});

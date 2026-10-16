import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';
import { Effect, Exit, Layer, Scope, Stream } from 'effect';

import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import {
  AppState,
  StateReadFailed,
  type StateStore,
} from '@platform/interfaces';
import type { OfferedTool, ToolDefinition } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingHost } from '@shared/state/stateSettings';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  fakeHostAppState,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { resolveTestStep } from '@test/support/stepToolsTestUtils';
import { texraPlugins } from '@texra/tools/registry';
import { ToolCatalog, toolCatalogLayer } from '@tools/liveTools';
import { mcpConfigPathOf } from '@tools/mcp/mcpConfig';
import { pluginCatalogLayer } from '@tools/pluginCatalog';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { toolTable } from '@tools/toolTable';
import { setToolEnabled } from '@tools/toolAvailability';

function toolDefs(names: readonly string[]): ToolDefinition[] {
  return names.map((name) => ({ name }));
}

describe('tool-use tool resolution', () => {
  function resolveNames(
    names: readonly string[],
    options: {
      approvalPromptsUnavailable: boolean;
      host?: SettingHost;
      injectTools?: boolean;
    },
  ) {
    return resolveTestStep({
      tools: toolDefs(names),
      injectTools: false,
      stores: hostStores(),
      workspaceRoot: undefined,
      host: 'vscode',
      ...options,
    }).pipe(
      Effect.map(({ definitions }) => definitions.map((tool) => tool.name)),
      Effect.scoped,
      // The delegation-annotation availability read yields `LanguageModel`;
      // this host has no editor models.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
      Effect.provide(
        pluginCatalogLayer(
          texraPlugins(),
          mcpConfigPathOf('/nonexistent'),
        ).pipe(
          Layer.provide(
            Layer.merge(nodePlatformLayer, AppState.layer(fakeHostAppState)),
          ),
        ),
      ),
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
          'agent',
          'grep',
          'inquiry',
          'plan',
          'send_to_terminal',
          'update_config',
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
        // The agent package embedded in another process is offered none of
        // the tools that need a product host's surfaces.
        expect(
          yield* resolveNames(['bash', 'inquiry', 'send_to_terminal'], {
            approvalPromptsUnavailable: false,
            host: 'sdk',
          }),
        ).toEqual(['bash']);
      }),
  );

  it.effect(
    'drops the agent tool when its plugin dashboard switch is disabled',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: {
              [GlobalStateKey.DISABLED_TOOLS]: ['multi-agent'],
            },
          }),
        );

        expect(
          yield* resolveNames(['bash', 'agent'], {
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
          parentOffered?: readonly OfferedTool[],
        ) =>
          resolveTestStep({
            tools: toolDefs(names),
            injectTools: false,
            stores: hostStores(),
            workspaceRoot: undefined,
            host: 'vscode',
            approvalPromptsUnavailable,
            parentOffered,
          });
        const parent = yield* resolve(['grep'], true);
        // The child's own host could answer approvals; its parent's could not.
        const child = yield* resolve(
          ['bash', 'grep', 'write_file'],
          false,
          parent.offered,
        );
        expect(child.definitions.map((tool) => tool.name)).toEqual(['grep']);
        const refused = yield* Effect.flip(
          resolve(['grep', 'mcp__candidate__*'], false, parent.offered),
        );
        expect(refused.message).toContain('mcp__candidate__*');
        expect(refused.message).toContain('MCP server "candidate"');
      }).pipe(
        Effect.scoped,
        Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
        Effect.provide(
          pluginCatalogLayer(
            texraPlugins(),
            mcpConfigPathOf('/nonexistent'),
          ).pipe(
            Layer.provide(
              Layer.merge(nodePlatformLayer, AppState.layer(fakeHostAppState)),
            ),
          ),
        ),
        Effect.provide(nodeSpawnerLayer),
      ),
  );

  it.effect(
    'a switch reaches the next pin; a step keeps its plugin layer until it closes',
    () => {
      const events: string[] = [];
      // One plugin whose layer records its lifetime.
      // A switchable plugin (`toggle`), so its stored switch counts.
      const table = toolTable([
        {
          id: 'zotero',
          tools: {
            zotero_search: {
              definition: { name: 'zotero_search' },
              call: () => Effect.die('not called'),
            },
          },
          toggle: 'off',
          availability: ALWAYS_AVAILABLE,
          processLayer: {
            layer: Layer.effectDiscard(
              Effect.acquireRelease(
                Effect.sync(() => events.push('open')),
                () => Effect.sync(() => events.push('close')),
              ),
            ),
          },
        },
      ]);
      return Effect.gen(function* () {
        const stores = hostStores();
        const resolve = (parentOffered?: readonly OfferedTool[]) =>
          resolveTestStep({
            tools: toolDefs(['zotero_search']),
            injectTools: false,
            stores,
            workspaceRoot: undefined,
            host: 'vscode',
            parentOffered,
          }).pipe(
            Effect.provide(
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
            ),
          );
        const names = (resolved: Effect.Success<ReturnType<typeof resolve>>) =>
          resolved.definitions.map((tool) => tool.name);

        const firstScope = yield* Scope.make();
        const first = yield* Scope.provide(resolve(), firstScope);
        expect(names(first)).toEqual(['zotero_search']);
        expect(events).toEqual(['open']);

        yield* setToolEnabled('zotero', false, stores.globalState);
        // The next pin is without the plugin, and a child reads the same
        // catalog: it cannot keep what its parent's step was
        // offered once the tool has left.
        const nextScope = yield* Scope.make();
        const next = yield* Scope.provide(resolve(), nextScope);
        expect(names(next)).toEqual([]);
        const child = yield* Scope.provide(resolve(first.offered), nextScope);
        expect(names(child)).toEqual([]);

        // The first step still holds the layer until it closes.
        expect(events).toEqual(['open']);
        yield* Scope.close(firstScope, Exit.void);
        expect(events).toEqual(['open', 'close']);
        yield* Scope.close(nextScope, Exit.void);
      }).pipe(
        Effect.provide(
          // No switch follower: only the steps hold the layer.
          toolCatalogLayer(table, { switches: Stream.never }).pipe(
            Layer.provide(
              Layer.merge(nodePlatformLayer, AppState.layer(fakeHostAppState)),
            ),
          ),
        ),
        Effect.provide(nodeSpawnerLayer),
        Effect.ensuring(Effect.promise(() => installPlatform())),
      );
    },
  );

  it.effect(
    'a failed MCP revision-key read is read again by the next run, not kept for the process',
    () => {
      let faults = 1;
      // File-local: the shared host fake has no way to fail one read once.
      const flaky: StateStore = {
        ...fakeHostAppState,
        get: (key) =>
          key === GlobalStateKey.MCP_REVISION_KEY && faults-- > 0
            ? Effect.fail(
                new StateReadFailed({
                  key,
                  message: 'store busy',
                  cause: null,
                }),
              )
            : fakeHostAppState.get(key),
      };
      return Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() =>
            mkdtempSync(path.join(os.tmpdir(), 'texra-mcp-key-')),
          ),
          (created) =>
            Effect.sync(() =>
              rmSync(created, { recursive: true, force: true }),
            ),
        );
        const file = path.join(dir, 'mcp.json');
        writeFileSync(
          file,
          JSON.stringify({
            mcpServers: { fixture: { command: path.join(dir, 'missing') } },
          }),
        );
        // One catalog for both runs: the key's cache is the catalog's.
        const catalog = yield* Layer.build(
          pluginCatalogLayer([], file).pipe(
            Layer.provide(
              Layer.merge(nodePlatformLayer, AppState.layer(flaky)),
            ),
          ),
        );
        const tools = yield* Effect.provide(
          Effect.gen(function* () {
            return yield* (yield* ToolCatalog).session;
          }),
          catalog,
        );
        const warnings = Effect.map(
          tools.hold(['mcp__fixture__echo'], true),
          (held) => held.warnings,
        );
        expect(yield* warnings).toEqual([
          expect.stringContaining('store busy'),
        ]);
        expect(yield* warnings).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nodeSpawnerLayer));
    },
  );
});

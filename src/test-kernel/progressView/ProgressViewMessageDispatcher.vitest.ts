/**
 * Characterization + migration tests for progressView's frontend
 * `dispatchMessage` (packages/extension/src/progressView/frontend/messageDispatcher.ts).
 *
 * Covers the two acceptance criteria from TeXRA#7442:
 *  - Dispatch parity: real outbound commands still reach the correct slice
 *    handler (which writes the shared `progressState` singletons directly),
 *    and malformed/unrecognized messages route to `onError` instead of
 *    throwing inside a handler body.
 *  - Unsupported-command capability gating: a registry entry declared
 *    `unsupported(...)` (the mechanism `ProgressViewOutboundHandlerRegistry`
 *    now requires every command to resolve to) surfaces a clear
 *    `UnsupportedCommandError` via `onError` instead of silently
 *    no-oping — exercised directly against the exported
 *    `dispatchProgressViewOutbound`, since the production registry (like
 *    settingsView's/webview's) has no live `unsupported()` entries today.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { PermissionState } from '@progressView/frontend/permissionState';
import {
  appState,
  permissions$,
  placement,
  resetProgressState,
} from '@progressView/frontend/progressState';
import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import {
  logListStateKey,
  webviewStorage,
} from '@progressView/frontend/webviewStorage';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { MAIN_VIEW_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchProgressViewOutbound,
  MainViewMessageSchema,
  ProgressViewOutboundMessageSchema,
  SyncStreamContentMessageSchema,
  type ProgressViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  assertKnownOutboundMessage,
  assertOutboundMessage,
  UnsupportedCommandError,
  unsupported,
} from '@shared/utils/dispatcher';

interface DiscriminatedSchemaNode {
  shape?: { command: { value: string } };
  options?: readonly DiscriminatedSchemaNode[];
}

function collectCommands(
  schema: DiscriminatedSchemaNode,
  commands: Set<string>,
): void {
  if (schema.shape) commands.add(schema.shape.command.value);
  for (const option of schema.options ?? []) {
    collectCommands(option, commands);
  }
}

/** Every command in the real outbound schema, including nested unions. */
function outboundCommands(): string[] {
  const commands = new Set<string>();
  collectCommands(
    ProgressViewOutboundMessageSchema as unknown as DiscriminatedSchemaNode,
    commands,
  );
  return [...commands];
}

describe('SyncStreamContentMessageSchema', () => {
  const workflow = {
    command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
    action: 'render',
    stream: 'workflow-stream',
    category: 'workflow',
    runUsage: {},
    outputs: { files: {}, missing: {}, compileFailures: {} },
    activeState: {
      conversationProgress: { toolCallCount: 0 },
      stage: null,
      badges: {
        subagents: [],
      },
    },
  } as const;
  const toolUse = {
    command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
    action: 'render',
    stream: 'tool-stream',
    category: 'toolUse',
    runUsage: {},
    workPlan: { todos: [], plan: null, queuedFollowUps: [] },
    controls: {
      bashBypass: false,
      toolEditBypass: false,
      superYoloBypass: false,
      goal: { active: false },
    },
  } as const;

  it.each([
    { command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT, action: 'clear' },
    workflow,
    toolUse,
  ])('accepts an exact transport variant', (message) => {
    expect(SyncStreamContentMessageSchema.safeParse(message).success).toBe(
      true,
    );
  });

  it.each([
    {
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      action: 'clear',
      stream: '',
    },
    { ...workflow, workPlan: toolUse.workPlan },
    { ...toolUse, outputs: workflow.outputs },
    {
      ...workflow,
      activeState: { conversationProgress: { toolCallCount: 1 } },
    },
    // Active state is all-or-nothing: a snapshot that omits the phase slot
    // would leave a stale cached phase on the frontend after a tab switch.
    {
      ...workflow,
      activeState: {
        conversationProgress: workflow.activeState.conversationProgress,
        stage: null,
        badges: workflow.activeState.badges,
        parentStreamId: null,
      },
    },
    {
      ...toolUse,
      controls: {
        ...toolUse.controls,
        goal: { active: true },
      },
    },
  ])('rejects a contradictory transport state', (message) => {
    expect(SyncStreamContentMessageSchema.safeParse(message).success).toBe(
      false,
    );
  });
});

function seedStreamWithLogListToggle(streamId: StreamTabId): void {
  appState.get().streamById.set(streamId, {
    name: streamId,
    label: streamId,
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
  });
  void webviewStorage.update(logListStateKey(streamId), {
    groupToggleStates: [['group-1', true]],
  });
}

describe('progressView dispatchMessage (createDispatcher migration)', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('routes SET_PLACEMENT to uiHandlers, which writes the placement singleton — dispatch parity', () => {
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.SET_PLACEMENT, placement: 'editor' },
      onError,
    );

    expect(handled).toBe(true);
    expect(placement.get()).toBe('editor');
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes DELETE_ALL to streamLifecycleHandlers, which clears the state singletons — dispatch parity', () => {
    permissions$.set([
      {
        kind: PERMISSION_KIND.PLAN_APPROVAL,
        data: {
          requestId: 'approval-1',
          streamId: 'stream-1' as StreamTabId,
          plan: { objective: 'Do the thing.' },
          goalEnabled: false,
        },
      } as PermissionState,
    ]);
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      onError,
    );

    expect(handled).toBe(true);
    expect(permissions$.get()).toEqual([]);
    expect(appState.get().streamById.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("DELETE_ALL clears every remaining stream's persisted LogList toggle state", () => {
    const streamId = 'stream-delete-all' as StreamTabId;
    seedStreamWithLogListToggle(streamId);
    expect(webviewStorage.get(logListStateKey(streamId))).toBeDefined();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(webviewStorage.get(logListStateKey(streamId))).toBeUndefined();
  });

  it("DELETE_STREAM clears that stream's persisted LogList toggle state", () => {
    const streamId = 'stream-delete-one' as StreamTabId;
    seedStreamWithLogListToggle(streamId);

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM, stream: streamId },
      vi.fn(),
    );

    expect(handled).toBe(true);
    expect(webviewStorage.get(logListStateKey(streamId))).toBeUndefined();
  });

  it('DELETE_STREAM clears retained child parent references', () => {
    const parent = 'stream-parent' as StreamTabId;
    const child = 'stream-child' as StreamTabId;
    seedStreamWithLogListToggle(parent);
    seedStreamWithLogListToggle(child);
    appState.get().streamById.set(child, {
      ...appState.get().streamById.get(child)!,
      parentStreamId: parent,
    });

    dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM, stream: parent },
      vi.fn(),
    );

    expect(
      appState.get().streamById.get(child)?.parentStreamId,
    ).toBeUndefined();
  });

  it('routes a malformed message to onError instead of throwing inside a handler body', () => {
    const before = appState.get();
    const onError = vi.fn();

    // SET_ACTIVE_STREAM requires `activeStream`; omitting it fails schema
    // validation before any handler runs.
    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM },
      onError,
    );

    expect(handled).toBe(false);
    expect(appState.get()).toBe(before);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ZodError);
  });

  it('routes an unrecognized command through the same schema-validation path', () => {
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: 'notARealProgressViewCommand' },
      onError,
    );

    expect(handled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ZodError);
  });

  it('does not throw for THEME_SET, though BaseWebviewApp intercepts it before dispatchMessage() in production', () => {
    // THEME_SET shares its command string with COMMON_COMMANDS.THEME_SET;
    // BaseWebviewApp's messageListener routes it through handleCommonMessage
    // before handleMessage/dispatchMessage ever sees it. uiHandlers still
    // carries a documented no-op entry to keep the outbound union exhaustive.
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.THEME_SET, theme: 'dark' },
      onError,
    );

    expect(handled).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('dispatchProgressViewOutbound Unsupported-command gating (@shared/utils/dispatcher wiring)', () => {
  function stubRegistry(): ProgressViewOutboundHandlerRegistry {
    return Object.fromEntries(
      outboundCommands().map((command) => [command, vi.fn()]),
    ) as unknown as ProgressViewOutboundHandlerRegistry;
  }

  it('turns an unsupported registry entry into a clear UnsupportedCommandError instead of a silent no-op', () => {
    const registry = stubRegistry();
    const reason = 'Not available on this host.';
    (registry as Record<string, unknown>)[
      PROGRESS_VIEW_COMMANDS.SET_PLACEMENT
    ] = unsupported(reason);
    const noOp = registry[PROGRESS_VIEW_COMMANDS.DELETE_ALL];
    const onError = vi.fn();

    const handled = dispatchProgressViewOutbound(
      { command: PROGRESS_VIEW_COMMANDS.SET_PLACEMENT, placement: 'editor' },
      registry,
      onError,
    );

    expect(handled).toBe(false);
    expect(noOp).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(UnsupportedCommandError);
    expect((error as UnsupportedCommandError).command).toBe(
      PROGRESS_VIEW_COMMANDS.SET_PLACEMENT,
    );
    expect((error as UnsupportedCommandError).reason).toBe(reason);
  });

  it('still dispatches every other real command normally when one entry is unsupported', () => {
    const registry = stubRegistry();
    (registry as Record<string, unknown>)[
      PROGRESS_VIEW_COMMANDS.SET_PLACEMENT
    ] = unsupported('Not available on this host.');
    const onError = vi.fn();

    const handled = dispatchProgressViewOutbound(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      registry,
      onError,
    );

    expect(handled).toBe(true);
    expect(registry[PROGRESS_VIEW_COMMANDS.DELETE_ALL]).toHaveBeenCalledTimes(
      1,
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

// #8123: outbound webview/desktop IPC (BaseWebviewManager.postMessage,
// desktopIpcTypes.ts's postToRenderer) now runs payloads through these
// existing outbound schemas before sending, mirroring the inbound-side
// validation `createDispatcher` already performs. Vitest runs with
// `NODE_ENV=test`, so `assertOutboundMessage`/`assertKnownOutboundMessage`
// are always in their dev/test-assertion (throwing) mode here.
describe('assertOutboundMessage / assertKnownOutboundMessage (#8123)', () => {
  const KNOWN_MESSAGE_SCHEMAS = [
    MainViewMessageSchema,
    ProgressViewOutboundMessageSchema,
  ];

  it('does not throw for a well-formed MainView outbound message', () => {
    expect(() =>
      assertOutboundMessage(MainViewMessageSchema, {
        command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
        filePath: 'paper.tex',
        fileType: 'input',
      }),
    ).not.toThrow();
  });

  it('throws when a MainView outbound message drifts from its schema (single-domain boundary, e.g. BaseWebviewManager.postMessage)', () => {
    expect(() =>
      assertOutboundMessage(MainViewMessageSchema, {
        command: MAIN_VIEW_COMMANDS.SET_CURRENT_FILE,
        // Missing `fileType` — required by SetCurrentFileMessageSchema.
        filePath: 'paper.tex',
      }),
    ).toThrow(/Outbound message failed schema validation/);
  });

  it('lets a command unrecognized by any listed domain pass through unchecked (desktop-only messages)', () => {
    expect(() =>
      assertKnownOutboundMessage(KNOWN_MESSAGE_SCHEMAS, {
        command: 'desktop:showPdf',
        title: 'paper.pdf',
        pdfPath: '/x.pdf',
      }),
    ).not.toThrow();
  });

  it.each([
    {
      name: "a command matches a known domain but fails that domain's own validation",
      // Missing `activeStream`, required by the SET_ACTIVE_STREAM schema.
      message: { command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM },
    },
    {
      name: 'a bad discriminator is nested inside a matched command (UPDATE_PERMISSION.action), not just a top-level unknown command',
      message: {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION,
        action: 'bogus',
      },
    },
  ])('throws when $name', ({ message }) => {
    expect(() =>
      assertKnownOutboundMessage(KNOWN_MESSAGE_SCHEMAS, message),
    ).toThrow(/Outbound message failed schema validation/);
  });
});

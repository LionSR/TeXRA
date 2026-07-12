/**
 * Characterization + migration tests for progressView's frontend
 * `dispatchMessage` (packages/extension/src/progressView/frontend/messageDispatcher.ts).
 *
 * Covers the two acceptance criteria from TeXRA#7442:
 *  - Dispatch parity: real outbound commands still reach the correct slice
 *    handler with `ctx` threaded through, and malformed/unrecognized
 *    messages route to `onError` instead of throwing inside a handler body.
 *  - Unsupported-command capability gating: a registry entry declared
 *    `unsupported(...)` (the mechanism `messageHandlerTypes.ts`'s
 *    `HandlerRegistry` now requires every command to resolve to) surfaces a
 *    clear `UnsupportedCommandError` via `onError` instead of silently
 *    no-oping — exercised directly against the exported
 *    `dispatchProgressViewOutbound`, since the production registry (like
 *    settingsView's/webview's) has no live `unsupported()` entries today.
 */
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import type { MessageHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import { MAIN_VIEW_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchProgressViewOutbound,
  MainViewMessageSchema,
  ProgressViewOutboundMessageSchema,
  type ProgressViewOutboundHandlerRegistry,
} from '@shared/schemas';
import {
  assertKnownOutboundMessage,
  assertOutboundMessage,
  UnsupportedCommandError,
  unsupported,
} from '@shared/utils/dispatcher';

/** Every command in the real outbound schema, including nested unions (UPDATE_PERMISSION). */
function outboundCommands(): string[] {
  const commands = new Set<string>();
  for (const opt of ProgressViewOutboundMessageSchema.options as Array<{
    shape?: { command: { value: string } };
    options?: Array<{ shape: { command: { value: string } } }>;
  }>) {
    if (opt.shape) {
      commands.add(opt.shape.command.value);
    } else if (opt.options) {
      for (const sub of opt.options) commands.add(sub.shape.command.value);
    }
  }
  return [...commands];
}

function createSpyContext(initialState: ProgressState = createInitialState()): {
  ctx: MessageHandlerContext;
  getState: () => ProgressState;
  setState: ReturnType<typeof vi.fn>;
  setPermissions: ReturnType<typeof vi.fn>;
  setPlacement: ReturnType<typeof vi.fn>;
} {
  let state = initialState;
  const setState = vi.fn();
  const setPermissions = vi.fn();
  const setPlacement = vi.fn();
  const ctx: MessageHandlerContext = {
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
      setState(updater);
    },
    setStreamState: () => {},
    setStreamLogs: () => {},
    savePrefs: () => {},
    getPermissions: () => [],
    setPermissions,
    setPlacement,
  };
  return { ctx, getState: () => state, setState, setPermissions, setPlacement };
}

describe('progressView dispatchMessage (createDispatcher migration)', () => {
  it('routes SET_PLACEMENT to uiHandlers with ctx threaded through — dispatch parity', () => {
    const { ctx, setPlacement } = createSpyContext();
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.SET_PLACEMENT, placement: 'editor' },
      ctx,
      onError,
    );

    expect(handled).toBe(true);
    expect(setPlacement).toHaveBeenCalledWith('editor');
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes DELETE_ALL to streamLifecycleHandlers with ctx threaded through — dispatch parity', () => {
    const { ctx, setPermissions, setState } = createSpyContext();
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      ctx,
      onError,
    );

    expect(handled).toBe(true);
    expect(setPermissions).toHaveBeenCalledWith([]);
    expect(setState).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a malformed message to onError instead of throwing inside a handler body', () => {
    const { ctx, setState } = createSpyContext();
    const onError = vi.fn();

    // SET_ACTIVE_STREAM requires `activeStream`; omitting it fails schema
    // validation before any handler runs.
    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM },
      ctx,
      onError,
    );

    expect(handled).toBe(false);
    expect(setState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ZodError);
  });

  it('routes an unrecognized command through the same schema-validation path', () => {
    const { ctx } = createSpyContext();
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: 'notARealProgressViewCommand' },
      ctx,
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
    const { ctx } = createSpyContext();
    const onError = vi.fn();

    const handled = dispatchMessage(
      { command: PROGRESS_VIEW_COMMANDS.THEME_SET, theme: 'dark' },
      ctx,
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
      assertKnownOutboundMessage(
        [MainViewMessageSchema, ProgressViewOutboundMessageSchema],
        { command: 'desktop:showPdf', title: 'paper.pdf', pdfPath: '/x.pdf' },
      ),
    ).not.toThrow();
  });

  it("throws when a command matches a known domain but fails that domain's own validation", () => {
    expect(() =>
      assertKnownOutboundMessage(
        [MainViewMessageSchema, ProgressViewOutboundMessageSchema],
        { command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM }, // missing `activeStream`
      ),
    ).toThrow(/Outbound message failed schema validation/);
  });

  it('throws for a bad discriminator nested inside a matched command (UPDATE_PERMISSION.action), not just a top-level unknown command', () => {
    expect(() =>
      assertKnownOutboundMessage(
        [MainViewMessageSchema, ProgressViewOutboundMessageSchema],
        { command: PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION, action: 'bogus' },
      ),
    ).toThrow(/Outbound message failed schema validation/);
  });
});

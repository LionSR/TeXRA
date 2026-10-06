// Third-party imports
import { Effect, type Scope } from 'effect';

// Local imports - runtime
import {
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
} from '@agent/runtime';
import type { LogLevel, RunId } from '@shared/schemas';
import { formatInstructionActionHint } from '@ui/copy/instructionActionHint';

// Local imports - CLI runtime
import {
  flushNdjsonStdout,
  writeNdjsonStdout,
  writeTextStderr,
} from './logSinks';
import { createRunProgressRenderer } from './runProgressRenderer';
import { missingAgentMessage } from './agents';
import type { CliContext } from './cliContext';

export interface CliRuntimeHost {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): boolean;
  attachRunProgressRenderer(
    session: SessionHandle,
    options?: { readonly runId?: RunId },
  ): Effect.Effect<void, never, Scope.Scope>;
  prepareInteractivePrompt?: () => void;
  close(): Effect.Effect<void>;
}

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  let closed = false;
  const ndjson = context.outputFormat === 'ndjson';
  const runProgress = createRunProgressRenderer(context);

  /** One presentation record. NDJSON: a `kind: 'log'` record on the public
   *  wire. Text: `LEVEL message` on stderr, the shape of the CLI's config
   *  warnings; the timestamp and fields stay in the NDJSON record. */
  function present(
    level: LogLevel,
    message: string,
    fields: { readonly [key: string]: unknown } = {},
  ): void {
    if (ndjson) {
      writeNdjsonStdout({
        kind: 'log',
        ts: new Date().toISOString(),
        level,
        message,
        fields,
      });
    } else {
      writeTextStderr(`${level.toUpperCase()} ${message}`);
    }
  }

  /**
   * The one runtime-presentation handler map, both modes. Every event returns
   * `true` when it rendered a user-visible record. `showAgentConfigBanner` is
   * rendered as a visible, actionable
   * "agent not found" error so CLI launch failures surface once through the
   * targeted path. Reproduced per-key rather than as a catch-all, so a future
   * `RuntimePresentationEventPayloads` addition is a compile error to decide
   * on rather than a silent fall-through.
   *
   * `requestOpenFile`, `requestEnsureProgressView`, `workspaceFilesWritten`
   * and `workspaceAgentsChanged` have no presentation of their own in either
   * mode.
   * `RUNTIME_PRESENTATION_NDJSON_CASES` in
   * `src/test-kernel/cli/RunProgressRenderer.vitest.ts` pins the exact record
   * set each event may emit in NDJSON mode.
   *
   * `runProgress?.preserve()` is inert in NDJSON mode: production never builds
   * a renderer there (`shouldRenderRunProgress`), and where a test context
   * does, `preserve()` no-ops behind its own `ansi && liveLine` guard.
   */
  const handlers: PresentationEventHandlers<RuntimePresentationEventPayloads> =
    {
      requestShowError: (payload) => {
        runProgress?.preserve();
        present('error', payload.message);
        return true;
      },
      requestShowInstruction: (payload) => {
        // An actionable instruction (e.g. missing API key), not routine
        // progress noise. The action hint is a text-mode affordance; NDJSON
        // carries the actions as fields instead.
        runProgress?.preserve();
        const hint = ndjson ? '' : formatInstructionActionHint(payload.actions);
        present('info', `${payload.message}${hint}`, {
          key: payload.key,
          actions: payload.actions,
          showSuppress: payload.showSuppress,
        });
        return true;
      },
      requestOpenFile: () => false,
      showAgentConfigBanner: ({ agentName }) => {
        runProgress?.preserve();
        present('error', missingAgentMessage(agentName));
        return true;
      },
      requestEnsureProgressView: () => false,
      // A terminal has no file tree to badge.
      workspaceFilesWritten: () => false,
      // No terminal view keeps an agent list to repaint.
      workspaceAgentsChanged: () => false,
    };

  return {
    attachRunProgressRenderer: (session, options) =>
      runProgress ? runProgress.attach(session, options) : Effect.void,
    prepareInteractivePrompt: () => runProgress?.preserve(),
    emit<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ): boolean {
      if (closed) return false;
      return handlers[event](payload) === true;
    },
    close() {
      return Effect.gen(function* () {
        closed = true;
        runProgress?.clear();
        // NDJSON records queue on the module-level stdout serializer; the
        // text mode writes stderr directly and buffers nothing.
        if (ndjson) yield* flushNdjsonStdout();
      });
    },
  };
}

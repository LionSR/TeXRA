/**
 * The stderr status line of `texra run` (PRD one-fold-three-renderers,
 * 10.3). It reads the session view and derives nothing the fold already
 * states; the renderer keeps only its own output state (what it last wrote).
 * The plain-text workflow lines are `scriptPlainOutput.ts`.
 */
import path from 'node:path';

import {
  Effect,
  type Fiber,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { RUN_PHASE, type RunId, type RunPhase } from '@shared/schemas';
import {
  isLiveRun,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { formatLoopPositionLabel } from '@shared/runs/runStatusDisplay';
import { formatCompactDuration, pluralize } from '@utils/text/stringUtils';

import {
  safeTerminalText,
  textDisplayWidth,
  truncateSummaryToWidth,
} from './terminalText';
import { getStderrColumns, writeRawStderr } from './logSinks';
import { claimRootRun, type RunProgressSession } from './sessionViewFollow';
import type { CliContext } from './cliContext';

const CLEAR_LINE = '\r\x1b[2K';
const ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH = 48;

export interface RunProgressRenderer {
  /** Follow the session's view until the scope closes; `runId` names the run
   *  to describe (the first root run the view gains after attach, when
   *  omitted). */
  attach(
    session: RunProgressSession,
    options?: { readonly runId?: RunId },
  ): Effect.Effect<void, never, Scope.Scope>;
  clear(): void;
  preserve(): void;
}

export interface RunProgressRendererInit {
  readonly colorEnabled: boolean;
  readonly write?: (text: string) => void;
  readonly nowMs?: () => number;
  readonly minIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly getColumns?: () => number | undefined;
}

export function shouldRenderRunProgress(
  context: Pick<CliContext, 'outputFormat' | 'quietLogs'>,
): boolean {
  return !context.quietLogs && context.outputFormat !== 'ndjson';
}

export function createRunProgressRenderer(
  context: CliContext,
  init?: RunProgressRendererInit,
): RunProgressRenderer | undefined {
  if (context.renderRunProgress !== true) return undefined;
  return new DefaultRunProgressRenderer({
    colorEnabled: context.stderrColorEnabled,
    ...init,
    getColumns:
      init?.getColumns ??
      (() => {
        const columns = getStderrColumns();
        return context.stderrIsTty && columns != null && columns > 0
          ? columns
          : undefined;
      }),
  });
}
class DefaultRunProgressRenderer implements RunProgressRenderer {
  private readonly attachedAt: number;
  private readonly write: (text: string) => void;
  private readonly nowMs: () => number;
  private readonly minIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly ansi: boolean;
  private readonly getColumns: () => number | undefined;
  private lastRenderAt = 0;
  private lastLine = '';
  private liveLine = false;
  private view: SessionView | undefined;
  private rootRunId: RunId | undefined;
  private wantedRunId: RunId | undefined;
  private attachCursor = 0;
  /** The last root phase the renderer painted; a repeat is not a change. */
  private paintedPhase: RunPhase | undefined;
  private heartbeat: Fiber.Fiber<never> | undefined;

  constructor(
    init: RunProgressRendererInit & {
      readonly getColumns: () => number | undefined;
    },
  ) {
    this.write = init.write ?? writeRawStderr;
    this.nowMs = init.nowMs ?? Date.now;
    this.minIntervalMs = init.minIntervalMs ?? 100;
    this.heartbeatIntervalMs = init.heartbeatIntervalMs ?? 1000;
    this.ansi = init.colorEnabled;
    this.getColumns = init.getColumns;
    this.attachedAt = this.nowMs();
  }

  attach(
    session: RunProgressSession,
    options: { readonly runId?: RunId } = {},
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.suspend(() => {
      this.wantedRunId = options.runId;
      this.attachCursor = SubscriptionRef.getUnsafe(session.view).cursor;
      return Effect.addFinalizer(() =>
        Effect.sync(() => {
          this.view = undefined;
        }),
      ).pipe(
        Effect.andThen(
          Effect.forkScoped(
            Effect.scoped(
              Stream.runForEach(session.viewChanges, (view) =>
                Effect.gen({ self: this }, function* () {
                  this.applyView(view);
                  if (this.rootRunTerminal || !this.rootRunId) {
                    this.stopHeartbeat();
                  } else if (this.ansi && !this.heartbeat) {
                    // A start waits a full interval. This stream's scope
                    // interrupts and joins the heartbeat when it ends.
                    this.heartbeat = yield* Effect.sleep(
                      this.heartbeatIntervalMs,
                    ).pipe(
                      Effect.andThen(Effect.sync(() => this.render(true))),
                      Effect.forever,
                      Effect.forkScoped({ startImmediately: true }),
                    );
                  }
                }),
              ),
            ).pipe(Effect.ensuring(Effect.sync(() => this.stopHeartbeat()))),
            { startImmediately: true },
          ),
        ),
        Effect.asVoid,
      );
    });
  }

  clear(): void {
    this.stopHeartbeat();
    if (this.ansi && this.liveLine) {
      this.write(CLEAR_LINE);
      this.liveLine = false;
    }
  }

  preserve(): void {
    this.stopHeartbeat();
    if (this.ansi && this.liveLine) {
      this.write('\n');
      this.liveLine = false;
    }
  }

  private root(): RunView | undefined {
    return this.rootRunId ? this.view?.runs.get(this.rootRunId) : undefined;
  }

  private get rootRunTerminal(): boolean {
    return isTerminalOutcomePhase(this.root()?.status);
  }

  private applyView(view: SessionView): void {
    const previous = this.view;
    this.view = view;
    this.rootRunId ??= claimRootRun(view, this.wantedRunId, this.attachCursor);
    const root = this.root();
    if (!root) return;
    const wasTerminal = isTerminalOutcomePhase(
      previous && this.rootRunId
        ? previous.runs.get(this.rootRunId)?.status
        : undefined,
    );
    const phase = root.status;
    const phaseChanged = phase !== 'ready' && phase !== this.paintedPhase;
    if (phaseChanged) this.paintedPhase = phase;
    // A terminal root freezes the line: the final status is its last paint.
    if (wasTerminal && !phaseChanged) return;
    this.render(phaseChanged || this.rootRunTerminal);
  }

  private liveChildren(): readonly RunView[] {
    const root = this.root();
    if (!root || this.rootRunTerminal) return [];
    return root.childIds.flatMap((childId) => {
      const child = this.view?.runs.get(childId);
      return child && isLiveRun(child) ? [child] : [];
    });
  }

  private render(force = false): void {
    const now = this.nowMs();
    if (!force && now - this.lastRenderAt < this.minIntervalMs) return;
    const { line, state } = this.formatLine(now);
    if (!line) return;
    if (this.ansi) {
      if (line === this.lastLine) return;
      this.write(`${CLEAR_LINE}${line}`);
      this.liveLine = true;
    } else {
      // Off a TTY every line is permanent, so one is written per change of
      // state; the elapsed clock alone ticking over is not a change.
      if (state === this.lastLine) return;
      this.write(`${line}\n`);
    }
    this.lastLine = this.ansi ? line : state;
    this.lastRenderAt = now;
  }

  private stopHeartbeat(): void {
    this.heartbeat?.interruptUnsafe();
    this.heartbeat = undefined;
  }

  /** The status line, and the same line without its elapsed clock. */
  private formatLine(now: number): {
    readonly line: string;
    readonly state: string;
  } {
    const root = this.root();
    if (!root) return { line: '', state: '' };
    // The fold's turn; a run whose loop has not moved yet carries none.
    // The agent as the cards name it (`runIdentityDisplayName`): a recipe
    // launch's `source:name` key reads as its name.
    const agentName = root.identity?.kind === 'agent' ? root.label : undefined;
    const parts: string[] = [];
    const turnLabel = formatLoopPositionLabel(root.turn);
    if (turnLabel !== undefined) parts.push(`[${turnLabel}]`);
    const subject = [agentName, formatInputLabel(root.inputFiles)]
      .filter(Boolean)
      .join(' ');
    const phase = livePhaseText(root);
    parts.push(subject || phase || 'Running');
    if (subject && phase && phase !== 'Running') parts.push(phase);
    const runStartedAt = root.runStartedAt ?? this.attachedAt;
    const elapsed = formatCompactDuration(now - runStartedAt);
    const children = this.liveChildren();
    const nameOnlySubagents = formatActiveChildren(children, 0);
    if (nameOnlySubagents) {
      const descriptionColumns = this.descriptionColumnBudget(
        parts,
        nameOnlySubagents,
        elapsed,
      );
      parts.push(formatActiveChildren(children, descriptionColumns)!);
    }
    const toolCallCount = root.conversationProgress.toolCallCount;
    if (toolCallCount && !nameOnlySubagents) {
      parts.push(`tools: ${toolCallCount}`);
    }
    const state = parts.join(' · ');
    return { line: `${state} · ${elapsed}`, state };
  }

  private descriptionColumnBudget(
    fixedParts: readonly string[],
    nameOnlySubagents: string,
    elapsed: string,
  ): number {
    const columns = normalizeTerminalColumns(this.getColumns());
    if (!this.ansi || columns == null) {
      return ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH;
    }
    const lineWithoutDescription = [
      ...fixedParts,
      nameOnlySubagents,
      elapsed,
    ].join(' · ');
    return Math.min(
      ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH,
      Math.max(
        0,
        columns -
          textDisplayWidth(lineWithoutDescription) -
          textDisplayWidth(' — '),
      ),
    );
  }
}

/** The fold's label (G4, one table) for every state but a running run,
 *  whose live task is its description once the AI one-liner has arrived. */
function livePhaseText(root: RunView): string | undefined {
  if (root.status === 'ready') return undefined;
  if (root.status === RUN_PHASE.RUNNING) {
    return root.description ?? root.statusLabel;
  }
  return root.statusLabel;
}

function formatInputLabel(files: readonly string[]): string | undefined {
  const first = files.at(0);
  if (!first) return undefined;
  const firstName = path.basename(first);
  return files.length === 1 ? firstName : `${firstName} +${files.length - 1}`;
}

/** The named agent children (a process child has no agent to name). */
function formatActiveChildren(
  children: readonly RunView[],
  descriptionColumns: number,
): string | undefined {
  const agents = children.filter((child) => child.identity?.kind === 'agent');
  const first =
    agents.find((child) => child.status === RUN_PHASE.RUNNING) ?? agents[0];
  if (!first) return undefined;
  const label = pluralize(agents.length, 'subagent');
  const suffix = agents.length > 1 ? ` +${agents.length - 1}` : '';
  const description = first.description;
  const safeDescription =
    description && descriptionColumns > 0
      ? truncateSummaryToWidth(
          safeTerminalText(description),
          descriptionColumns,
        )
      : '';
  const task = safeDescription ? ` — ${safeDescription}` : '';
  return `${label}: ${first.label}${task}${suffix}`;
}

function normalizeTerminalColumns(
  columns: number | undefined,
): number | undefined {
  if (columns == null || !Number.isFinite(columns)) return undefined;
  return Math.max(0, Math.floor(columns));
}

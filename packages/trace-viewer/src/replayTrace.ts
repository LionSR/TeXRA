import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import type {
  ProgressViewOutboundMessage,
  RunIdentity,
  StreamLifecycleStatus,
  StreamTabInfo,
  SyncStreamContentPayload,
} from '@shared/schemas';
import {
  AgentCategory,
  executionStatusToRunOutcome,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_STATUS,
  StreamLifecycleStatusSchema,
  streamStatusToLifecycleStatus,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { TraceDocument } from '@transcript';
import { isObject } from '@utils/core';

type UpdateStreamsMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS }
>;
type LogDeltaMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.LOG_DELTA }
>;
type SyncStreamContentMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT }
>;

/**
 * Stage kinds nested under the root "Run:" stage (see `StageOptions.kind` in
 * `@agent/trace`). A tool-use round (and any other non-root stage of these
 * kinds) is opened without an ambient parent — `runFlowWithLifecycle` never
 * wraps flow execution in the root stage's `within(...)` — so its `GROUP_END`
 * row gets `groupId === undefined` just like the root run stage's own. Only
 * the root stage's row is tagged `kind: 'run'` (or has no `kind` at all, for
 * traces recorded before stage kinds existed); anything tagged with one of
 * these kinds is a nested stage that happens to share the root's "no parent"
 * shape and must be excluded from the reverse scan below.
 */
const NESTED_STAGE_KINDS = new Set(['round', 'phase', 'session']);

/**
 * Identifies the root run stage's entry id by structural position, for
 * archived traces where `data.kind` isn't available to check — recorded
 * before `TexraTranscriptRecorder` started re-attaching `kind` across the
 * stage.end merge, or even before per-stage `kind` existed at all. The stage
 * label (`entry.text`) isn't a safe fallback either: it's arbitrary
 * human-authored text with no enforced format guarantee across every past
 * recorder revision (see the "Legacy run" fixture in
 * `replayTrace.vitest.ts`'s issue #7188 case).
 *
 * What *is* guaranteed for every historical trace: each stage occupies
 * exactly one entry for its whole lifetime — `stage.end` mutates that same
 * entry in place (`StreamLogStore.update` / `StreamLog.update`) rather than
 * appending a new one — so a stage's position in `trace.entries` is fixed at
 * `stage.start` time and never moves. `beginRunStage` opens the root run
 * stage before any flow (and therefore any tool-use round, which shares the
 * root's "no parent" `groupId === undefined` shape) ever starts, so among
 * every top-level stage entry the root's is always the earliest by seqNo.
 * Any later entry sharing that "no parent" shape is a nested round/phase/
 * session stage that started after the root, never the root itself.
 */
function findRootStageId(
  entries: TraceDocument['entries'],
): string | undefined {
  return entries.find(
    (entry) =>
      entry.groupId === undefined &&
      (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START ||
        entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END),
  )?.id;
}

/**
 * Maps the persisted-history `ExecutionStatus` onto the `StreamLifecycleStatus`
 * vocabulary `StreamMetadataSchema.status` renders. `executionStatusToRunOutcome`
 * is the sanctioned inverse of `runOutcomeToExecutionStatus` — its `RunOutcome`
 * result (`completed`/`cancelled`/`failed`) is structurally identical to
 * `StreamPhase`'s values, so it's already a valid `StreamLifecycleStatus`.
 *
 * `terminalStatus` is `null` for traces that predate outcome tracking (or
 * never reached a terminal state). For those legacy traces, derive status from
 * the persisted transcript's last terminal group row before falling back to the
 * older snapshot-status escape hatch. Only when neither source records a
 * terminal status does this default to `READY`, same as an unqualified
 * successful finish.
 *
 * The terminal group row's `data.status` is parsed with
 * `StreamLifecycleStatusSchema` (StreamPhase-or-legacy-StreamStatus union,
 * already shipped — §2), not the narrower legacy-only `StreamStatusSchema`:
 * `assembleTrace()` (src/transcript/traceAssembler.ts) is a `StreamLogStore`
 * client, so every `TraceDocument` it builds — including one assembled from
 * pre-cutover on-disk history — carries the canonical `RunOutcome` values
 * `StreamLogStore.parsePersistedEntries` normalizes to (#7993 step 2), not
 * just the legacy 2-value `EndGroupStatus` strings a genuinely
 * externally-authored, never-reassembled `trace.json` predating this cutover
 * would still carry. `StreamLifecycleStatusSchema` accepts both, so this one
 * parse call keeps working for freshly-`assembleTrace()`d documents and for
 * historical exported files alike — no per-entry rewrite of `trace.entries`,
 * which stays exactly the future work §8.3 scopes separately.
 */
function toStreamLifecycleStatus(trace: TraceDocument): StreamLifecycleStatus {
  if (trace.terminalStatus !== null) {
    const outcome = executionStatusToRunOutcome(trace.terminalStatus);
    if (outcome) return outcome;
  }
  const rootStageId = findRootStageId(trace.entries);
  for (const entry of trace.entries.toReversed()) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END) continue;
    if (entry.groupId !== undefined) continue;
    if (!isObject(entry.data)) continue;
    const kind =
      typeof entry.data.kind === 'string' ? entry.data.kind : undefined;
    if (kind !== undefined) {
      if (NESTED_STAGE_KINDS.has(kind)) continue;
    } else if (entry.id !== rootStageId) {
      // No `data.kind` to check — this entry predates kind-tagging
      // altogether. Fall back to the structural ordering invariant: only
      // the entry at the root stage's fixed position (the first top-level
      // stage entry in the trace) can be the run's own GROUP_END; anything
      // else sharing the "no parent" shape is a nested round/phase/session.
      continue;
    }
    const status = StreamLifecycleStatusSchema.safeParse(entry.data.status);
    if (status.success) return status.data;
  }
  return trace.snapshot.status
    ? streamStatusToLifecycleStatus(trace.snapshot.status)
    : STREAM_STATUS.READY;
}

/** The record's display name across both arms of the config union. */
export function recordName(config: TraceDocument['config']): string {
  return 'agentCategory' in config ? config.agent : config.name;
}

function legacyTraceIdentity(trace: TraceDocument): RunIdentity {
  const streamId = trace.streamId;
  const name = recordName(trace.config);
  if (streamId.startsWith('workflow-script#')) {
    return { kind: 'multiAgentWorkflow', workflowName: name };
  }
  if (streamId.startsWith('codex@')) {
    return { kind: 'agent', agent: name, tool: 'codex' };
  }
  if (streamId.startsWith('claude@')) {
    return { kind: 'agent', agent: name, tool: 'claude_code' };
  }
  if (streamId.startsWith('bash@')) {
    return { kind: 'process', tool: 'bash' };
  }
  return { kind: 'agent', agent: name };
}

/**
 * Replays one finished execution through the REAL `dispatchMessage` pipeline
 * as a short synthetic message sequence — the same reducer logic a live host
 * uses, just fed once instead of over time. Order matters: `LOG_DELTA` is a
 * no-op unless `UPDATE_STREAMS` has already registered the stream (see
 * `logSlice.ts`'s `if (!streamState) return`).
 */
export function replayTrace(trace: TraceDocument): void {
  const { snapshot } = trace;
  const agentConfig =
    'agentCategory' in trace.config ? trace.config : undefined;
  const streamTabBase = {
    name: trace.streamId,
    label: recordName(trace.config),
    agentCategory: agentConfig?.agentCategory,
    // Empty-entries traces have nothing to derive a creation time from;
    // fall back to "now" rather than the Unix epoch, which would render
    // as a misleadingly specific (and wrong) 1970 date.
    creationTimestamp: trace.entries[0]?.timestamp ?? Date.now(),
    executionId: trace.executionId,
    description: trace.meta?.description,
  };
  // The embedded ExecutionMeta carries the run's identity. Pre-migration
  // exports have no identity and are NOT all agent runs (bash process and
  // workflow-script traces exist), so classify from the trace's stream-id
  // prefix. An exported trace file is immutable, so unlike the storage-side
  // readers retired in #9590 Stage 7 this fallback is permanent: it is the
  // only place a stream-id prefix may be read as evidence.
  const identity: RunIdentity =
    trace.meta?.identity ?? legacyTraceIdentity(trace);
  const streamTabInfo: StreamTabInfo =
    identity.kind === 'process'
      ? { ...streamTabBase, identity, command: trace.config.instruction }
      : { ...streamTabBase, identity, model: trace.config.model };
  const updateStreams: UpdateStreamsMessage = {
    command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    streams: [streamTabInfo],
    activeStream: trace.streamId,
    streamStates: {
      [trace.streamId]: {
        status: toStreamLifecycleStatus(trace),
        category: agentConfig?.agentCategory,
        conversationProgress: snapshot.conversationProgress,
        // Liveness is never restored as live (matches the existing
        // ghost-stream hydrate convention documented on StreamSnapshot) —
        // an archived trace has no in-flight children regardless of what a
        // stale snapshot recorded.
        subagents: [],
      },
    },
  };
  dispatchMessage(updateStreams);

  const logDelta: LogDeltaMessage = {
    command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
    streamId: trace.streamId,
    entries: trace.entries,
    updates: [],
    textDeltas: [],
  };
  dispatchMessage(logDelta);

  const syncSnapshot = {
    action: 'render' as const,
    stream: trace.streamId,
    runUsage: snapshot.runUsage,
  };
  // Workflow-shaped sync for workflow agents AND multi-agent-workflow
  // containers (both have round outputs); everything else renders the
  // tool-use shape.
  const syncPayload: SyncStreamContentPayload =
    agentConfig?.agentCategory === AgentCategory.Workflow ||
    identity.kind === 'multiAgentWorkflow'
      ? {
          ...syncSnapshot,
          category: AgentCategory.Workflow,
          outputs: {
            files: snapshot.outputFilesByRound,
            missing: snapshot.missingOutputsByRound,
            compileFailures: snapshot.compileFailuresByRound,
          },
        }
      : {
          ...syncSnapshot,
          category: AgentCategory.ToolUse,
          workPlan: {
            todos: snapshot.todos,
            plan: snapshot.plan,
            queuedFollowUps: [],
          },
          controls: {
            bashBypass: false,
            toolEditBypass: false,
            superYoloBypass: false,
            goal: { active: false },
          },
        };
  const syncContent: SyncStreamContentMessage = {
    command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
    ...syncPayload,
  };
  dispatchMessage(syncContent);
}

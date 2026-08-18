// Fold-vs-oracle equivalence for the CLI transcript projection (#9946).
//
// The projection over store-emitted StreamLogDeltas is a fold; the oracle is
// the same application code run from scratch over getRange(0) — which is
// also the production resync path. Two streams receive an identical
// randomized op interleaving: stream A keeps its fold state across every
// emission, stream B has its state invalidated before every sync so it
// always rebuilds. After every op, both slices must project identically.
// A divergence means an in-place mutation, ordering rule, or promotion was
// folded incorrectly — the regression class this change makes possible.

import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  activeStreamId,
  patchStream,
  resetCliState,
  setStreamStatusInCliState,
  streams,
  type ConversationEntry,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';
import {
  invalidateTranscriptFoldForTest,
  subscribeStreamLog,
  syncStreamLog,
  transcriptFoldCountersForTest,
} from '@cli/chat/tui/state/subscribeStreamLog';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type RunIdentity,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import {
  appendTranscriptEntry,
  appendTranscriptText,
  updateTranscriptEntry,
  withTranscriptWriter,
} from '@test/support/storeTestDrivers';

const FOLD_STREAM = 'fold-stream' as StreamTabId;
const ORACLE_STREAM = 'oracle-stream' as StreamTabId;
const OTHER_STREAM = 'other-stream' as StreamTabId;
const MIRRORED = [FOLD_STREAM, ORACLE_STREAM] as const;

/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

interface StreamConfig {
  readonly name: string;
  readonly category: AgentCategory;
  readonly identity?: RunIdentity;
}

const CONFIGS: readonly StreamConfig[] = [
  { name: 'tool-use transcript', category: AgentCategory.ToolUse },
  { name: 'workflow operational feed', category: AgentCategory.Workflow },
  {
    name: 'workflow full-log child',
    category: AgentCategory.Workflow,
    identity: {
      kind: 'multiAgentWorkflow',
      workflowName: 'draft-sections',
    } as RunIdentity,
  },
];

/** The projected fields the fold and the oracle must agree on. */
function projectedView(slice: StreamSlice | undefined): unknown {
  return {
    entries: slice?.entries ?? [],
    latestLine: slice?.latestLine,
    thinkingActive: slice?.thinkingActive ?? false,
    compactingActive: slice?.compactingActive ?? false,
    activeSkills: slice?.activeSkills ?? [],
    taskGroups: slice?.taskGroups ?? [],
    workflowAttemptId: slice?.workflowAttemptId,
    workflowAttemptBoundaryDeclared:
      slice?.workflowAttemptBoundaryDeclared ?? false,
  };
}

/** Mutation-op generator driving both mirrored streams identically. */
class MirroredOps {
  private readonly openText: string[] = [];
  private readonly openThinking: string[] = [];
  private readonly openTools: string[] = [];
  private readonly openGroups: Array<{ id: string; kind?: string }> = [];
  private readonly openCalls: Array<{ id: string; label: string }> = [];
  private nextId = 0;
  private syntheticSeq = 0;

  constructor(private readonly rng: () => number) {}

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private append(
    entry: Omit<StreamLogEntry, 'seqNo' | 'settlementSeqNo'>,
  ): void {
    const store = defaultSession().transcripts;
    for (const streamId of MIRRORED) {
      appendTranscriptEntry(store, streamId, entry);
    }
  }

  private update(
    id: string,
    patch: Parameters<typeof updateTranscriptEntry>[3],
    settle = false,
  ): void {
    const store = defaultSession().transcripts;
    for (const streamId of MIRRORED) {
      if (settle) {
        withTranscriptWriter(store, streamId, (writer) =>
          writer.settle(id, patch),
        );
      } else {
        updateTranscriptEntry(store, streamId, id, patch);
      }
    }
  }

  /** Apply one random mutation to both streams. */
  step(): void {
    const roll = this.rng();
    if (roll < 0.08) {
      this.append({
        id: this.id('u'),
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.USER_MESSAGE,
        text: `question ${this.nextId}`,
      });
    } else if (roll < 0.2) {
      const id = this.id('m');
      this.openText.push(id);
      this.append({
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        text: '',
        data: { status: 'running' },
      });
    } else if (roll < 0.42 && this.openText.length > 0) {
      const id = pick(this.rng, this.openText);
      const store = defaultSession().transcripts;
      for (const streamId of MIRRORED) {
        appendTranscriptText(store, streamId, id, ` chunk${this.nextId}`);
      }
      this.nextId += 1;
    } else if (roll < 0.45 && this.openText.length > 0) {
      // Non-terminal in-place update on a row that keeps streaming: emits a
      // dirtied entry by value while the row stays open, so later appendText
      // chunks land on top of a buffered value (the delta feed's
      // value-supersedes-chunks precedence, exercised in both directions).
      const id = pick(this.rng, this.openText);
      this.update(id, { data: { status: 'running', tick: this.nextId++ } });
    } else if (roll < 0.5 && this.openText.length > 0) {
      const id = this.openText.shift() as string;
      this.update(id, { data: { status: 'completed' } }, true);
    } else if (roll < 0.55) {
      const id = this.id('th');
      this.openThinking.push(id);
      this.append({
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.THINKING,
        text: 'thinking…',
        data: { status: 'running' },
      });
    } else if (roll < 0.6 && this.openThinking.length > 0) {
      const id = this.openThinking.shift() as string;
      this.update(id, { data: { status: 'completed' } });
    } else if (roll < 0.68) {
      const id = this.id('t');
      this.openTools.push(id);
      this.append({
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.TOOL_USE,
        text: 'Bash',
        data: {
          toolName: 'Bash',
          input: { command: `echo ${this.nextId}` },
          status: 'in_progress',
        },
      });
    } else if (roll < 0.74 && this.openTools.length > 0) {
      const id = this.openTools.shift() as string;
      const failed = this.rng() < 0.25;
      this.update(
        id,
        {
          data: {
            toolName: 'Bash',
            input: { command: 'echo' },
            status: failed ? 'failed' : 'completed',
            output: failed ? undefined : `ok ${id}`,
            error: failed ? `exit 1 from ${id}` : undefined,
          },
        },
        true,
      );
    } else if (roll < 0.8) {
      const kind = pick(this.rng, ['phase', 'round', undefined] as const);
      const id = this.id('g');
      this.openGroups.push({ id, kind });
      this.append({
        id,
        type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: `Stage ${this.nextId}`,
        data: {
          status: 'running',
          ...(kind ? { kind } : {}),
          ...(kind === 'phase' ? { index: this.nextId % 5, total: 5 } : {}),
        },
      });
    } else if (roll < 0.84 && this.openGroups.length > 0) {
      const group = this.openGroups.shift() as { id: string; kind?: string };
      this.update(
        group.id,
        {
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: {
            status: this.rng() < 0.2 ? 'failed' : 'completed',
            ...(group.kind ? { kind: group.kind } : {}),
            endTime: this.nextId,
          },
        },
        true,
      );
    } else if (roll < 0.88) {
      const id = this.id('w');
      const call = { id, label: `call ${this.nextId}` };
      this.openCalls.push(call);
      this.append({
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.WORKFLOW_TASK,
        text: call.label,
        data: { id: call.id, label: call.label, status: 'planned' },
      });
    } else if (roll < 0.91 && this.openCalls.length > 0) {
      const call = pick(this.rng, this.openCalls);
      const terminal = this.rng() < 0.5;
      if (terminal) {
        this.openCalls.splice(this.openCalls.indexOf(call), 1);
      }
      this.update(
        call.id,
        {
          data: {
            id: call.id,
            label: call.label,
            status: terminal ? 'completed' : 'running',
          },
        },
        terminal,
      );
    } else if (roll < 0.94) {
      this.append({
        id: this.id('e'),
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.ERROR,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.ERROR,
        text: `failure ${this.nextId}`,
        data: { message: `detail ${this.nextId}` },
      });
    } else if (roll < 0.97) {
      const malformed = this.rng() < 0.4;
      this.append({
        id: this.id('sk'),
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: this.nextId,
        messageType: MESSAGE_TYPES.ACTIVE_SKILLS,
        text: 'skills',
        data: malformed
          ? { skills: [{ path: '/secret' }] }
          : {
              skills: [
                {
                  name: `skill-${this.nextId}`,
                  description: 'A skill.',
                  source: 'project',
                },
              ],
            },
      });
    } else {
      const syntheticId = `local:${this.syntheticSeq++}`;
      const store = defaultSession().transcripts;
      for (const streamId of MIRRORED) {
        const head = store.get(streamId)?.head ?? 0;
        patchStream(streamId, (slice) => {
          const entry: ConversationEntry = {
            id: syntheticId,
            role: 'assistant',
            text: `local notice ${syntheticId}`,
            finalized: true,
            synthetic: true,
            syntheticKind: 'local',
            syntheticAfterSeq: head,
            syntheticAfterSettlementSeqNo: 0,
          };
          return { ...slice, entries: [...slice.entries, entry] };
        });
      }
    }
  }
}

function syncBothAndCompare(
  step: number,
  extra = '',
  options: { readonly forceFinal?: boolean } = {},
): void {
  // Both mirrored streams must project under the same focus state, but the
  // trailing focusStream(onlyIfUnset) inside sync would otherwise focus
  // whichever mirrored stream synced first — restore the entering focus
  // around each sync (unset ⇒ both project the full transcript).
  const active = activeStreamId.get();
  syncStreamLog(FOLD_STREAM, options);
  activeStreamId.set(active);
  invalidateTranscriptFoldForTest(ORACLE_STREAM);
  syncStreamLog(ORACLE_STREAM, options);
  activeStreamId.set(active);
  const fold = projectedView(streams.get().get(FOLD_STREAM));
  const oracle = projectedView(streams.get().get(ORACLE_STREAM));
  expect(fold, `step ${step}${extra}`).toEqual(oracle);
}

function configureStreams(config: StreamConfig): void {
  for (const streamId of MIRRORED) {
    patchStream(streamId, (slice) => ({
      ...slice,
      category: config.category,
      ...(config.identity ? { identity: config.identity } : {}),
    }));
  }
}

/** Subscribe for the duration of `fn`, disposing even if an assertion throws. */
function withStreamSubscription(fn: () => void): void {
  const dispose = subscribeStreamLog();
  try {
    fn();
  } finally {
    dispose();
  }
}

describe('transcript fold vs from-scratch oracle', () => {
  beforeEach(async () => {
    await defaultSession().transcripts.clear();
    // Twice: the first reset retires the ids this suite reuses across tests,
    // the second starts the lifetime with no retired identity.
    resetCliState();
    resetCliState();
  });

  it.each(
    CONFIGS.flatMap((config) =>
      [1337, 20260811].map((seed) => ({ config, seed })),
    ),
  )(
    'folds identically to the oracle: $config.name (seed $seed)',
    ({ config, seed }) => {
      withStreamSubscription(() => {
        const rng = createRng(seed);
        const ops = new MirroredOps(rng);
        configureStreams(config);
        activeStreamId.set(undefined);
        for (const streamId of MIRRORED) {
          setStreamStatusInCliState({
            streamId,
            status: STREAM_PHASE.RUNNING,
          });
        }
        const before = transcriptFoldCountersForTest();

        const STEPS = 160;
        for (let step = 0; step < STEPS; step += 1) {
          ops.step();
          // Occasionally settle the whole stream, then resume: exercises the
          // streamFinal promotion flip in both directions.
          const statusRoll = rng();
          if (statusRoll < 0.05) {
            for (const streamId of MIRRORED) {
              setStreamStatusInCliState({
                streamId,
                status: STREAM_PHASE.WAITING,
              });
            }
          } else if (statusRoll < 0.1) {
            for (const streamId of MIRRORED) {
              setStreamStatusInCliState({
                streamId,
                status: STREAM_PHASE.RUNNING,
              });
            }
          }
          syncBothAndCompare(step, ` (seed ${seed})`);
        }

        // The property is only meaningful if the fold path actually ran:
        // stream A folds every step after its first sync's rebuild.
        const after = transcriptFoldCountersForTest();
        expect(after.folds - before.folds).toBeGreaterThanOrEqual(STEPS - 1);
      });
    },
  );

  it('projects the compact unfocused-workflow selection identically', () => {
    withStreamSubscription(() => {
      const rng = createRng(4242);
      const ops = new MirroredOps(rng);
      configureStreams(CONFIGS[1]);
      // Focus a third stream: both mirrored streams project the compact
      // dashboard selection. Status stays RUNNING so no release path fires.
      activeStreamId.set(OTHER_STREAM);
      for (const streamId of MIRRORED) {
        setStreamStatusInCliState({ streamId, status: STREAM_PHASE.RUNNING });
      }

      for (let step = 0; step < 120; step += 1) {
        ops.step();
        syncBothAndCompare(step, ' (compact)');
      }
    });
  });

  it('folds a hidden workflow-attempt marker into projection state', () => {
    withStreamSubscription(() => {
      configureStreams(CONFIGS[1]);
      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'workflow-attempt-current',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'workflowAttempt', attemptId: 'current-attempt' },
      });

      syncStreamLog(FOLD_STREAM);

      const slice = streams.get().get(FOLD_STREAM);
      expect(slice?.workflowAttemptId).toBe('current-attempt');
      expect(slice?.workflowAttemptBoundaryDeclared).toBe(true);
      expect(slice?.entries).toEqual([]);

      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'unrelated-internal',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 2,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'otherInternalRecord' },
      });
      syncStreamLog(FOLD_STREAM);
      expect(streams.get().get(FOLD_STREAM)?.workflowAttemptId).toBe(
        'current-attempt',
      );

      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'workflow-attempt-malformed',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 3,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'workflowAttempt', attemptId: '' },
      });
      syncStreamLog(FOLD_STREAM);
      const invalidSlice = streams.get().get(FOLD_STREAM);
      expect(invalidSlice?.workflowAttemptId).toBeUndefined();
      expect(invalidSlice?.workflowAttemptBoundaryDeclared).toBe(true);
      expect(invalidSlice?.entries).toEqual([]);
    });
  });

  it('evicts a failed prior attempt when a new workflow attempt starts', () => {
    withStreamSubscription(() => {
      configureStreams(CONFIGS[2]);
      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'workflow-attempt-old',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 1,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'workflowAttempt', attemptId: 'attempt-old' },
      });
      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'old-failed',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.ERROR,
        timestamp: 2,
        messageType: MESSAGE_TYPES.WORKFLOW_TASK,
        text: 'Failed: Agent runtime + its tests — HTTP 402 Payment Required',
        data: {
          id: 'agent-runtime',
          label: 'Agent runtime + its tests',
          status: 'failed',
          error: 'HTTP 402 Payment Required',
          attemptId: 'attempt-old',
        },
      });
      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'survey-complete-old',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 3,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'Survey complete: 0/32 areas reported, 0 raw candidates',
      });
      syncStreamLog(FOLD_STREAM);
      expect(
        streams
          .get()
          .get(FOLD_STREAM)
          ?.entries.map((entry) => entry.id),
      ).toEqual(expect.arrayContaining(['old-failed', 'survey-complete-old']));

      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'workflow-attempt-new',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 4,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'workflowAttempt', attemptId: 'attempt-new' },
      });
      appendTranscriptEntry(defaultSession().transcripts, FOLD_STREAM, {
        id: 'new-running',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 5,
        messageType: MESSAGE_TYPES.WORKFLOW_TASK,
        text: 'Running: Agent runtime + its tests',
        data: {
          id: 'agent-runtime',
          label: 'Agent runtime + its tests',
          status: 'running',
          attemptId: 'attempt-new',
        },
      });
      syncStreamLog(FOLD_STREAM);

      const ids =
        streams
          .get()
          .get(FOLD_STREAM)
          ?.entries.map((entry) => entry.id) ?? [];
      expect(ids).not.toContain('old-failed');
      expect(ids).not.toContain('survey-complete-old');
      expect(ids).toContain('new-running');
    });
  });

  it('does not settle a running compaction on a turn-boundary forceFinal', () => {
    // Regression: `forceFinal` (turn-boundary syncStreamLog callers)
    // must only drive settled-prefix promotion. Compaction settlement derives
    // from the real lifecycle phase — a forceFinal while a compaction is
    // still running must not record it as interrupted, or the later
    // completion event lands beyond the settlement boundary and is ignored.
    withStreamSubscription(() => {
      const store = defaultSession().transcripts;
      configureStreams(CONFIGS[0]);
      activeStreamId.set(undefined);
      for (const streamId of MIRRORED) {
        setStreamStatusInCliState({ streamId, status: STREAM_PHASE.RUNNING });
        appendTranscriptEntry(store, streamId, {
          id: 'u1',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 1,
          messageType: MESSAGE_TYPES.USER_MESSAGE,
          text: 'please compact',
        });
        appendTranscriptEntry(store, streamId, {
          id: 'c-start',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 2,
          messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
          text: 'Compacting context…',
          data: {
            activity: 'context_compaction',
            operationId: 'op-1',
            state: 'started',
          },
        });
      }
      syncBothAndCompare(0, ' (running compaction)');

      // Turn-boundary finalize while the compaction is still running.
      const before = transcriptFoldCountersForTest();
      syncBothAndCompare(1, ' (forceFinal)', { forceFinal: true });
      expect(transcriptFoldCountersForTest().folds).toBeGreaterThan(
        before.folds,
      );
      const slice = streams.get().get(FOLD_STREAM);
      const row = slice?.entries.find((e) => e.id === 'compaction:op-1');
      expect(row?.text).toBe('Compacting context…');
      expect(row?.finalized).toBe(false);
      expect(slice?.compactingActive).toBe(true);
      // The settled prefix ahead of the compaction is still promoted.
      expect(slice?.entries.find((e) => e.id === 'u1')?.finalized).toBe(true);

      // The later completion event must still complete the block.
      for (const streamId of MIRRORED) {
        appendTranscriptEntry(store, streamId, {
          id: 'c-done',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 3,
          messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
          text: 'Conversation context compacted',
          data: {
            activity: 'context_compaction',
            operationId: 'op-1',
            state: 'completed',
          },
        });
      }
      syncBothAndCompare(2, ' (completion)');
      const done = streams
        .get()
        .get(FOLD_STREAM)
        ?.entries.find((e) => e.id === 'compaction:op-1');
      expect(done?.text).toBe('Context compacted');
      expect(done?.finalized).toBe(true);
      expect(streams.get().get(FOLD_STREAM)?.compactingActive).toBe(false);
    });
  });

  it('recovers from a delta gap by rebuilding through the oracle path', () => {
    const store = defaultSession().transcripts;
    const first = subscribeStreamLog();
    appendTranscriptEntry(store, FOLD_STREAM, {
      id: 'u1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text: 'first',
    });
    syncStreamLog(FOLD_STREAM);
    expect(
      streams
        .get()
        .get(FOLD_STREAM)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['first']);

    // Deltas emitted while unsubscribed are lost: a real gap.
    first();
    for (const text of ['second', 'third']) {
      appendTranscriptEntry(store, FOLD_STREAM, {
        id: `u-${text}`,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 2,
        messageType: MESSAGE_TYPES.USER_MESSAGE,
        text,
      });
    }

    const second = subscribeStreamLog();
    appendTranscriptEntry(store, FOLD_STREAM, {
      id: 'u4',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 3,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text: 'fourth',
    });
    const before = transcriptFoldCountersForTest();
    syncStreamLog(FOLD_STREAM);
    const after = transcriptFoldCountersForTest();

    // The buffered delta's base does not match the fold state: the sync must
    // rebuild (not fold) and converge on the full transcript.
    expect(after.rebuilds - before.rebuilds).toBe(1);
    expect(
      streams
        .get()
        .get(FOLD_STREAM)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['first', 'second', 'third', 'fourth']);

    second();
  });
});

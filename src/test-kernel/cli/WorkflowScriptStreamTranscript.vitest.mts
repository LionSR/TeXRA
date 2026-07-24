// A detached delegate_workflow_script run owns a child stream. Its phases and
// typed task records render through the focused-child viewport, while the
// workflow-specific header identifies the kind of child execution.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@test/support/defaultSessionTestSetup';
import { defaultSession } from '@agent/runtime/SessionHandle';

import {
  StaticConversationTranscript,
  appendStaticTranscriptItems,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import { splitTranscriptEntries } from '@cli/chat/tui/panes/transcriptEntries';
import {
  patchStream,
  resetCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import { clearAllStreamStatusesForTest } from '@test/helpers/streamStatusTestUtils';
import { loadInk } from '@test/support/inkTestHarness.mts';
import { createRunTrace } from '@transcript';

// The `workflow-script#` prefix is what marks this stream as a child run whose
// full log output surfaces when focused.
const STREAM_ID = 'workflow-script#exec-1' as StreamTabId;
const PARENT_STREAM_ID = 'parent' as StreamTabId;
const SESSION_META = {
  agent: 'research',
  category: 'workflow',
  model: 'deepseekT',
  modelSource: 'builtin-default',
  cwd: '/tmp/project',
  apiMode: 'personal',
  approvalPolicy: 'yolo',
  canDelegate: true,
  transcriptMode: 'persistent',
  version: '0.39.6',
} as const;

async function renderStaticTranscript(): Promise<string> {
  const { ink, React } = await loadInk();
  return ink.renderToString(
    React.createElement(StaticConversationTranscript, {
      ownerKey: 'root',
      scrollbackStreamId: STREAM_ID,
      width: 80,
    }),
    { columns: 80 },
  );
}

beforeEach(async () => {
  resetCliState();
  clearAllStreamStatusesForTest(defaultSession().status);
  await defaultSession().transcripts.clear();
  patchStream(STREAM_ID, (slice) => ({ ...slice, model: 'deepseekT' }));
});

afterEach(() => {
  resetCliState();
});

describe('CLI workflow-script child-stream transcript', () => {
  it('updates one visible task record from planned to completed', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'introduction-task',
        task: {
          id: 'introduction',
          label: 'Draft introduction',
          phase: 'Draft sections',
          status: 'planned',
        },
      });
      syncStreamLog(STREAM_ID);
      expect(
        streams
          .get()
          .get(STREAM_ID)
          ?.entries.find((entry) => entry.id === 'introduction-task')?.text,
      ).toBe('Planned: Draft introduction');

      const phase = runTrace.trace.openStage('Draft sections', {
        id: 'draft-phase',
        kind: 'phase',
      });
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'introduction-task',
        stageId: phase.id,
        task: {
          id: 'introduction',
          label: 'Draft introduction',
          phase: 'Draft sections',
          status: 'running',
        },
      });
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'introduction-task',
        stageId: phase.id,
        task: {
          id: 'introduction',
          label: 'Draft introduction',
          phase: 'Draft sections',
          status: 'completed',
          model: 'deepseekT',
          durationMs: 12_000,
          totalCostUsd: 0.002,
        },
      });
      phase.end('completed');

      syncStreamLog(STREAM_ID);

      const entries = streams.get().get(STREAM_ID)?.entries ?? [];
      const texts = entries.map((entry) => entry.text);
      // The phase group row and the task's current state both surface.
      expect(texts).toContain('Draft sections');
      expect(texts).toContain(
        'Finished: Draft introduction · deepseekT · 12s · $0.002 total',
      );
      expect(
        entries.filter((entry) => entry.id === 'introduction-task'),
      ).toHaveLength(1);

      // The phase group is a distinct `role: 'phase'` header, not a plain
      // assistant row, so the CLI can render it as a divider between phases.
      const phaseEntry = entries.find(
        (entry) => entry.text === 'Draft sections',
      );
      expect(phaseEntry).toMatchObject({
        role: 'phase',
        phaseLabel: 'Draft sections',
        finalized: true,
      });

      // Finalize the stream so the settled prefix promotes into scrollback.
      patchStream(STREAM_ID, (slice) => ({
        ...slice,
        status: STREAM_PHASE.COMPLETED,
      }));
      syncStreamLog(STREAM_ID);

      const finalized = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(
        splitTranscriptEntries(finalized, STREAM_PHASE.COMPLETED).pending,
      ).toEqual([]);

      const staticItems = appendStaticTranscriptItems({
        childStreamEntries: new Map([
          [
            STREAM_ID,
            {
              kind: 'live' as const,
              active: true,
              parent: {
                kind: 'roster' as const,
                retained: { streamId: PARENT_STREAM_ID, order: 1 },
              },
              summary: {
                agentName: 'draft-sections',
                executionId: 'exec-1',
                kind: 'subagent' as const,
                toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
              },
            },
          ],
        ]),
        currentItems: [],
        meta: SESSION_META,
        parentStream: new Map([[STREAM_ID, PARENT_STREAM_ID]]),
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(staticItems.at(0)).toMatchObject({
        identityLine:
          'workflow script: draft-sections · parent: main · model: deepseekT',
        kind: 'header',
      });

      const output = await renderStaticTranscript();
      // The phase header renders with its distinct diamond divider glyph.
      expect(output).toContain('◆ Draft sections');
      expect(output).toContain('Finished: Draft introduction');
      expect(output).toContain('deepseekT · 12s · $0.002 total');
    } finally {
      runTrace.dispose();
    }
  });
});

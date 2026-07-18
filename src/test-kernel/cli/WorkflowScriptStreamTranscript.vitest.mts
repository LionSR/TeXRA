// A detached delegate_workflow_script run owns a child stream. Its phases and
// per-agent log lines render through the focused-child viewport, while the
// workflow-specific header identifies the kind of child execution.

import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@test/support/defaultSessionTestSetup';
import { clearAllStreamStatusesForTest } from '@test/helpers/streamStatusTestUtils';

import { createRunTrace } from '@transcript';
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

// The `workflow-script#` prefix is what marks this stream as a child run whose
// full log output surfaces when focused.
const STREAM_ID = 'workflow-script#exec-1' as StreamTabId;
const PARENT_STREAM_ID = 'parent' as StreamTabId;
const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

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
  const ink = (await import(cliRequire.resolve('ink'))) as any;
  const React = ((await import(cliRequire.resolve('react'))) as any).default;
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
  it('renders phases and per-agent log lines from the run stream trace', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      const phase = runTrace.trace.openStage('Draft sections', {
        id: 'draft-phase',
        kind: 'phase',
      });
      runTrace.trace.info('Running: introduction', { stageId: phase.id });
      runTrace.trace.info('Finished: introduction ($0.002 total)', {
        stageId: phase.id,
      });
      phase.end('completed');

      syncStreamLog(STREAM_ID);

      const entries = streams.get().get(STREAM_ID)?.entries ?? [];
      const texts = entries.map((entry) => entry.text);
      // The phase group row surfaces its label; the agent lines surface as
      // their own generic assistant rows — the parity bar for a focused run.
      expect(texts).toContain('Draft sections');
      expect(texts).toContain('Running: introduction');
      expect(texts).toContain('Finished: introduction ($0.002 total)');

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
      expect(output).toContain('Running: introduction');
      expect(output).toContain('Finished: introduction ($0.002 total)');
    } finally {
      runTrace.dispose();
    }
  });
});

// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

// Local imports
import type { ReportReviewIssueSink } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { ReportReviewIssueTool } from '@tools/ReportReviewIssueTool';

const REPORT = {
  file: 'src/x.ts',
  startLine: 5,
  severity: 'critical',
  title: 'Broken loop',
  description: 'Off-by-one in bounds.',
} as const;

let detachHostInteractions = (): void => {};

/** Attach a review sink the way a host does: as a session capability. */
function useReviewSink(sink: ReportReviewIssueSink): void {
  detachHostInteractions();
  detachHostInteractions = defaultSession().useHostInteractions({
    reportReviewIssue: sink,
    cancel: () => undefined,
  });
}

function useAcceptingSink(): {
  sink: Mock<ReportReviewIssueSink>;
  tool: ReportReviewIssueTool;
} {
  const sink = vi.fn<ReportReviewIssueSink>(() => ({ accepted: true }));
  useReviewSink(sink);
  return { sink, tool: new ReportReviewIssueTool() };
}

describe('ReportReviewIssueTool', () => {
  afterEach(() => {
    detachHostInteractions();
    detachHostInteractions = () => undefined;
  });

  it('hands the report to the sink and confirms acceptance', async () => {
    const { sink, tool } = useAcceptingSink();

    const result = await tool.call({
      ...REPORT,
      endLine: 7,
      suggestion: 'Use < instead of <=.',
    });

    expect(result).toMatchObject({
      summary: expect.stringContaining('src/x.ts:5'),
    });
    expect(sink).toHaveBeenCalledWith({
      file: 'src/x.ts',
      startLine: 5,
      endLine: 7,
      severity: 'critical',
      title: 'Broken loop',
      description: 'Off-by-one in bounds.',
      suggestion: 'Use < instead of <=.',
    });
  });

  it('streams each finding to the sink immediately and unchanged', async () => {
    const { sink, tool } = useAcceptingSink();
    const first = { ...REPORT, endLine: 7 };
    const second = {
      ...REPORT,
      file: 'src/y.ts',
      startLine: 11,
      title: 'Dropped result',
    };

    await tool.call(first);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith({
      ...first,
      suggestion: undefined,
    });

    await tool.call(second);

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith({
      ...second,
      endLine: undefined,
      suggestion: undefined,
    });
  });

  it('normalizes null optional fields to undefined for the sink', async () => {
    const { sink, tool } = useAcceptingSink();

    await tool.call({ ...REPORT, endLine: null, suggestion: null });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ endLine: undefined, suggestion: undefined }),
    );
  });

  it('reports that agent review is unavailable when no host serves it', async () => {
    const tool = new ReportReviewIssueTool();

    const result = await tool.call(REPORT);

    expect(result).toMatchObject({
      summary: 'Review issue not accepted',
      output: expect.stringContaining('not available'),
    });
  });

  it('surfaces the sink rejection reason when a review session refuses it', async () => {
    useReviewSink(() => ({
      accepted: false,
      reason: 'No agent review session is collecting issues.',
    }));
    const tool = new ReportReviewIssueTool();

    const result = await tool.call(REPORT);

    expect(result).toMatchObject({
      summary: 'Review issue not accepted',
      output: expect.stringContaining('No agent review session'),
    });
  });

  it('rejects invalid input before reaching the sink', async () => {
    const { sink, tool } = useAcceptingSink();

    const result = await tool.call({ ...REPORT, severity: 'fatal' });

    expect(result).toMatchObject({ status: 'error' });
    expect(sink).not.toHaveBeenCalled();
  });
});

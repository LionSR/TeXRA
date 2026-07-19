// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - tools
import {
  ReportReviewIssueTool,
  setReportReviewIssueSink,
  type ReportReviewIssueSink,
} from '@tools/ReportReviewIssueTool';

const REPORT = {
  file: 'src/x.ts',
  startLine: 5,
  severity: 'critical',
  title: 'Broken loop',
  description: 'Off-by-one in bounds.',
} as const;

describe('ReportReviewIssueTool', () => {
  beforeEach(() => {
    setReportReviewIssueSink(() => ({
      accepted: false,
      reason: 'Agent review is not available in this host.',
    }));
  });

  it('hands the report to the sink and confirms acceptance', async () => {
    const sink = vi.fn<ReportReviewIssueSink>(() => ({ accepted: true }));
    setReportReviewIssueSink(sink);
    const tool = new ReportReviewIssueTool();

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
    const sink = vi.fn<ReportReviewIssueSink>(() => ({ accepted: true }));
    setReportReviewIssueSink(sink);
    const tool = new ReportReviewIssueTool();
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
    const sink = vi.fn<ReportReviewIssueSink>(() => ({ accepted: true }));
    setReportReviewIssueSink(sink);
    const tool = new ReportReviewIssueTool();

    await tool.call({ ...REPORT, endLine: null, suggestion: null });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ endLine: undefined, suggestion: undefined }),
    );
  });

  it('surfaces the rejection reason when no review session is active', async () => {
    const tool = new ReportReviewIssueTool();

    const result = await tool.call(REPORT);

    expect(result).toMatchObject({
      summary: 'Review issue not accepted',
      output: expect.stringContaining('not available'),
    });
  });

  it('rejects invalid input before reaching the sink', async () => {
    const sink = vi.fn<ReportReviewIssueSink>(() => ({ accepted: true }));
    setReportReviewIssueSink(sink);
    const tool = new ReportReviewIssueTool();

    const result = await tool.call({ ...REPORT, severity: 'fatal' });

    expect(result).toMatchObject({ status: 'error' });
    expect(sink).not.toHaveBeenCalled();
  });
});

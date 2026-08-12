// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - tools
import * as arxivShared from '@tools/arxiv/arxivShared';
import * as rateLimiter from '@tools/citation/rateLimiter';
import { ArxivSearchTool } from '@tools/arxiv/ArxivSearchTool';

const sampleEntries = [
  {
    id: 'http://arxiv.org/abs/1234.5678v1',
    title: 'Test Paper',
    summary: 'Abstract',
    doi: { id: '10.1000/example' },
    published: new Date('2024-01-01'),
    updated: new Date('2024-01-02'),
    authors: [{ name: 'Author One' }],
    primaryCategory: { term: 'cs.AI' },
  },
];

describe('ArxivSearchTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds keyword queries for multi-word input', async () => {
    const captured: Record<string, unknown> = {};

    vi.spyOn(rateLimiter, 'waitForRateLimit').mockResolvedValue(undefined);

    vi.spyOn(arxivShared, 'createArxivClient').mockImplementation(
      () =>
        ({
          query(value: { toString: () => string }) {
            captured.query = value.toString();
            return this;
          },
          start(value: number) {
            captured.start = value;
            return this;
          },
          maxResults(value: number) {
            captured.maxResults = value;
            return this;
          },
          sortBy(value: string) {
            captured.sortBy = value;
            return this;
          },
          sortOrder(value: string) {
            captured.sortOrder = value;
            return this;
          },
          async execute() {
            return sampleEntries;
          },
        }) as unknown as arxivShared.ArxivClientInstance,
    );

    const tool = new ArxivSearchTool();
    const result = await tool.call({
      query: 'quantum error correction',
      start: 2,
      maxResults: 5,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });

    expect(captured).toEqual({
      query: '(all:"quantum" AND all:"error" AND all:"correction")',
      start: 2,
      maxResults: 5,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });

    expect(result.output).toBeTruthy();
    const output = JSON.parse(result.output as string) as {
      count: number;
      results: { id: string }[];
    };
    expect(output.count).toBe(sampleEntries.length);
    expect(output.results[0]?.id).toBe('1234.5678v1');
  });
});

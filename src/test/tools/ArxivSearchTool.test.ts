// Node.js built-in imports
import * as assert from 'assert';

// Local imports - tools
import * as arxivShared from '@tools/latex/arxivShared';
import * as rateLimiter from '@tools/citation/rateLimiter';
import { ArxivSearchTool } from '@/tools/arxiv/ArxivSearchTool';

describe('ArxivSearchTool', () => {
  const originalCreateArxivClient = arxivShared.createArxivClient;
  const originalWaitForRateLimit = rateLimiter.waitForRateLimit;

  afterEach(() => {
    (
      arxivShared as unknown as {
        createArxivClient: typeof originalCreateArxivClient;
      }
    ).createArxivClient = originalCreateArxivClient;
    (
      rateLimiter as unknown as {
        waitForRateLimit: typeof originalWaitForRateLimit;
      }
    ).waitForRateLimit = originalWaitForRateLimit;
  });

  it('builds keyword queries for multi-word input', async () => {
    const captured: {
      query?: string;
      start?: number;
      maxResults?: number;
      sortBy?: string;
      sortOrder?: string;
    } = {};

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

    (
      rateLimiter as unknown as {
        waitForRateLimit: typeof originalWaitForRateLimit;
      }
    ).waitForRateLimit = async () => {};

    (
      arxivShared as unknown as {
        createArxivClient: typeof originalCreateArxivClient;
      }
    ).createArxivClient = () =>
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
      }) as unknown as arxivShared.ArxivClientInstance;

    const tool = new ArxivSearchTool();
    const result = await tool.call({
      query: 'quantum error correction',
      start: 2,
      maxResults: 5,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });

    assert.strictEqual(
      captured.query,
      '(all:"quantum" AND all:"error" AND all:"correction")',
    );
    assert.strictEqual(captured.start, 2);
    assert.strictEqual(captured.maxResults, 5);
    assert.strictEqual(captured.sortBy, 'relevance');
    assert.strictEqual(captured.sortOrder, 'descending');

    const output = result.output ? JSON.parse(result.output) : null;
    assert.ok(output);
    assert.strictEqual(output.count, sampleEntries.length);
    assert.strictEqual(output.results[0].id, '1234.5678v1');
  });
});

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTool: vi.fn(),
  registerTool: vi.fn(),
}));

class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

class LanguageModelToolResult {
  constructor(public readonly content: unknown[]) {}
}

vi.mock('vscode', () => ({
  lm: { registerTool: mocks.registerTool },
  LanguageModelTextPart,
  LanguageModelToolResult,
}));

vi.mock('@logger/logUtils', () => ({
  warn: vi.fn(),
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@tools/registry', () => ({
  getDefaultToolRegistry: () => ({ get: mocks.getTool }),
}));

const { registerLanguageModelTools } =
  await import('@frontend/lm/registerLanguageModelTools');

describe('registerLanguageModelTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerTool.mockImplementation(() => ({ dispose: vi.fn() }));
  });

  it('adapts the search-only Crossref host input to the canonical command', async () => {
    const crossrefCall = vi.fn(async () => ({
      status: 'executed' as const,
      output: 'result',
    }));
    mocks.getTool.mockImplementation((name: string) => ({
      call: name === 'crossref_search' ? crossrefCall : vi.fn(),
    }));

    const context = { subscriptions: [] };
    registerLanguageModelTools(
      context as unknown as Parameters<typeof registerLanguageModelTools>[0],
    );

    const registration = mocks.registerTool.mock.calls.find(
      ([name]) => name === 'texra_crossref_search',
    );
    expect(registration).toBeDefined();

    await registration?.[1].invoke({
      input: { query: 'attention is all you need', rows: 5 },
    });

    expect(crossrefCall).toHaveBeenCalledWith({
      command: 'search',
      query: 'attention is all you need',
      rows: 5,
    });
  });
});

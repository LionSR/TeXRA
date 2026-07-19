import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { injectStandaloneTrace, type TraceDocument } from '@transcript';

function trace(overrides: Partial<TraceDocument> = {}): TraceDocument {
  return {
    executionId: 'exec-1' as ExecutionId,
    streamId: 'orchestrator@deepseekT#exec-1' as StreamTabId,
    config: {
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
      editedFile: null,
      agent: 'orchestrator',
      model: 'deepseekT',
      instruction: 'Solve the problem.',
      agentCategory: AgentCategory.ToolUse,
      editedFiles: [],
      toolConfig: DEFAULT_TOOL_CONFIG,
      memories: [],
      workingDirectory: '/workspace',
      cliOutputFile: null,
      cliMultiAgentPresetId: null,
    },
    meta: null,
    entries: [],
    snapshot: {
      schemaVersion: 1,
      streamId: 'orchestrator@deepseekT#exec-1' as StreamTabId,
      todos: [],
      plan: null,
      planSummary: null,
      outputFilesByRound: {},
      missingOutputsByRound: {},
      compileFailuresByRound: {},
      runUsage: {},
      status: 'ready',
      conversationProgress: { toolCallCount: 0 },
      finishedSubagentCount: 0,
      finishedProcessCount: 0,
      activeSubagents: [],
      activeProcesses: [],
    },
    terminalStatus: null,
    ...overrides,
  };
}

const TEMPLATE =
  '<!doctype html><html><head><title>t</title>' +
  '<script type="module" crossorigin src="./index.js"></script>' +
  '</head><body></body></html>';

describe('injectStandaloneTrace', () => {
  it('inserts an inline script before the module script tag', () => {
    const html = injectStandaloneTrace(TEMPLATE, trace());
    const scriptIndex = html.indexOf('<script>window.__TEXRA_TRACE__');
    const moduleIndex = html.indexOf('<script type="module"');
    expect(scriptIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(moduleIndex);
  });

  it('embeds the trace as valid, round-trippable JSON', () => {
    const t = trace({ executionId: 'exec-roundtrip' as ExecutionId });
    const html = injectStandaloneTrace(TEMPLATE, t);
    const match = /window\.__TEXRA_TRACE__ = (.*?);<\/script>/s.exec(html);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed.executionId).toBe('exec-roundtrip');
  });

  it('escapes a literal </script> inside trace data instead of truncating the page', () => {
    const t = trace({
      meta: {
        schemaVersion: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        description: '</script><img src=x onerror=alert(1)>',
      },
    });
    const html = injectStandaloneTrace(TEMPLATE, t);

    // The dangerous substring must not appear literally in the output.
    expect(html).not.toContain('</script><img');
    // The module script tag that follows must still be intact — a naive
    // injection would have let the payload's </script> close our tag early,
    // stranding the module script tag as visible text instead of markup.
    expect(html).toContain(
      '<script type="module" crossorigin src="./index.js"></script>',
    );

    const match = /window\.__TEXRA_TRACE__ = (.*?);<\/script>/s.exec(html);
    const parsed = JSON.parse(match![1]);
    expect(parsed.meta.description).toBe(
      '</script><img src=x onerror=alert(1)>',
    );
  });

  it('throws a clear error when the template has no module script tag', () => {
    expect(() => injectStandaloneTrace('<html></html>', trace())).toThrow(
      /missing its module/,
    );
  });
});

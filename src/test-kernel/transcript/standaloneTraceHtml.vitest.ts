import { describe, expect, it } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  StreamSnapshotSchema,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { injectStandaloneTrace, type TraceDocument } from '@transcript';

const STREAM_ID = 'orchestrator@deepseekT#exec-1' as StreamTabId;

function trace(overrides: Partial<TraceDocument> = {}): TraceDocument {
  return {
    executionId: 'exec-1' as ExecutionId,
    streamId: STREAM_ID,
    config: AgentConfigSchema.parse({
      agent: 'orchestrator',
      model: 'deepseekT',
      instruction: 'Solve the problem.',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: '/workspace',
    }),
    meta: null,
    entries: [],
    snapshot: StreamSnapshotSchema.parse({
      streamId: STREAM_ID,
      status: 'ready',
    }),
    terminalStatus: null,
    ...overrides,
  };
}

const TEMPLATE =
  '<!doctype html><html><head><title>t</title>' +
  '<script type="module" crossorigin src="./index.js"></script>' +
  '</head><body></body></html>';

function embeddedTrace(html: string): TraceDocument {
  const match = /window\.__TEXRA_TRACE__ = (.*?);<\/script>/s.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as TraceDocument;
}

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

    expect(embeddedTrace(html).executionId).toBe('exec-roundtrip');
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

    expect(embeddedTrace(html).meta?.description).toBe(
      '</script><img src=x onerror=alert(1)>',
    );
  });

  it('throws a clear error when the template has no module script tag', () => {
    expect(() => injectStandaloneTrace('<html></html>', trace())).toThrow(
      /missing its module/,
    );
  });
});

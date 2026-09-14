import { describe, expect, it } from 'vitest';

import {
  aggregateId,
  DisplaySessionEventSchema,
  LOG_LEVELS,
  MESSAGE_TYPES,
  type RunId,
} from '@shared/schemas';
import { injectStandaloneTrace, type TraceDocument } from '@transcript';

const RUN_ID = 'ab0001' as RunId;

function trace(message = 'hello'): TraceDocument {
  return {
    runId: RUN_ID,
    events: [
      DisplaySessionEventSchema.parse({
        aggregateId: aggregateId('run', RUN_ID),
        seq: 1,
        commit: 1,
        ownerId: null,
        at: 1_767_225_600_000,
        type: 'log',
        level: LOG_LEVELS.INFO,
        messageType: MESSAGE_TYPES.DEFAULT,
        message,
      }),
    ],
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
  it('escapes a literal </script> inside trace data instead of truncating the page', () => {
    const payload = '</script><img src=x onerror=alert(1)>';
    const html = injectStandaloneTrace(TEMPLATE, trace(payload));

    // The dangerous substring must not appear literally in the output.
    expect(html).not.toContain('</script><img');
    // The module script tag that follows must still be intact — a naive
    // injection would have let the payload's </script> close our tag early,
    // stranding the module script tag as visible text instead of markup.
    expect(html).toContain(
      '<script type="module" crossorigin src="./index.js"></script>',
    );

    expect(embeddedTrace(html).events[0]).toMatchObject({ message: payload });
  });

  it('throws a clear error when the template has no module script tag', () => {
    expect(() => injectStandaloneTrace('<html></html>', trace())).toThrow(
      /missing its module/,
    );
  });
});

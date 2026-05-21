// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - logger
import { composeSinks, createRedactingSink } from '@logger/sinks';
import type { LogRecord, LogSink } from '@logger/structuredLogger';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-05-21T00:00:00.000Z',
    level: 'info',
    message: 'OPENAI_API_KEY=sk-1234567890abcdef',
    fields: {
      path: '/Users/alice/private-paper/main.tex',
      token: 'Bearer ghp_1234567890abcdef',
      count: 1,
    },
    groups: ['/Users/alice/private-paper'],
    ...overrides,
  };
}

describe('logger sinks', () => {
  it('composes writes and lifecycle calls across sinks', async () => {
    const writes: string[] = [];
    const closed: string[] = [];
    const makeSink = (name: string): LogSink => ({
      write: (entry) => {
        writes.push(`${name}:${entry.message}`);
      },
      flush: async () => {
        closed.push(`${name}:flush`);
      },
      close: async () => {
        closed.push(`${name}:close`);
      },
    });

    const sink = composeSinks([makeSink('left'), makeSink('right')]);
    sink.write(record({ message: 'hello' }));
    await sink.flush?.();
    await sink.close?.();

    expect(writes).toEqual(['left:hello', 'right:hello']);
    expect(closed).toEqual([
      'left:flush',
      'right:flush',
      'left:close',
      'right:close',
    ]);
  });

  it('redacts messages, string fields, and group labels', () => {
    let written: LogRecord | undefined;
    const sink = createRedactingSink(
      {
        write: (entry) => {
          written = entry;
        },
      },
      {
        homeDir: '/Users/alice',
        workspacePath: '/Users/alice/private-paper',
      },
    );

    sink.write(record());

    expect(written?.message).toBe('OPENAI_API_KEY=[redacted]');
    expect(written?.fields).toMatchObject({
      path: '[path]/main.tex',
      token: 'Bearer [redacted]',
      count: 1,
    });
    expect(written?.groups).toEqual(['[path]']);
  });
});

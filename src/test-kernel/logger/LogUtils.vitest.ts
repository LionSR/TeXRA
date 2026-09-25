import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink, type LogEntry } from '@logger/logSink';
import * as logger from '@logger/logUtils';

const SECRET = 'sk-proj-redaction-example-1234567890abcdef';

/** Install a capturing sink and return the entries it receives. */
function captureEntries(options?: { trusted: boolean }): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogSink({ write: (entry) => entries.push(entry) }, options);
  return entries;
}

/** The payload annotation an entry carries, rendered by the write path. */
function payloadOf(entry: LogEntry | undefined): string {
  return String(entry?.annotations['data'] ?? '');
}

describe('logUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLogSink(null);
  });

  it('keeps pre-platform error logging working', () => {
    const entries = captureEntries();

    expect(() =>
      logger.error('startup', 'pre-init failure', { data: new Error('boom') }),
    ).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('ERROR');
  });

  it('redacts entries sent to a sink by default', () => {
    const entries = captureEntries();

    logger.info('test', `OPENAI_API_KEY=${SECRET}`);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).not.toContain(SECRET);
    expect(entries[0]?.message).toContain('OPENAI_API_KEY=[redacted]');
  });

  it('preserves the raw message for an explicitly trusted sink', () => {
    const entries = captureEntries({ trusted: true });

    const rawMessage = `OPENAI_API_KEY=${SECRET}`;
    logger.info('test', rawMessage);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe(rawMessage);
  });

  it('keeps severity and redaction on the default console fallback', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLogSink(null);

    logger.warn('test', `Authorization: Bearer ${SECRET}`);

    expect(consoleWarn).toHaveBeenCalledOnce();
    const output = String(consoleWarn.mock.calls[0]?.[0]);
    expect(output).not.toContain(SECRET);
    expect(output).toContain('Authorization: Bearer [redacted]');
  });

  it('redacts the rendered payload before sending it to the sink', () => {
    const entries = captureEntries();

    logger.debug('test', 'request metadata', {
      data: {
        authorization: `Bearer ${SECRET}`,
        password: 'correct horse battery staple',
        refreshToken: 'opaque-refresh-credential',
        requestId: 'visible-request-id',
      },
    });

    const payload = payloadOf(entries[0]);
    expect(entries).toHaveLength(1);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain('correct horse battery staple');
    expect(payload).not.toContain('opaque-refresh-credential');
    expect(payload).toContain('"authorization": "Bearer [redacted]"');
    expect(payload).toContain('"password": "[redacted]"');
    expect(payload).toContain('"refreshToken": "[redacted]"');
    expect(payload).toContain('"requestId": "visible-request-id"');
  });

  it('redacts a long secret before truncating its rendered payload', () => {
    const entries = captureEntries();
    const password = `visible-secret-prefix-${'x'.repeat(3_000)}`;
    // A deep stack sorts ahead of `runId`; it renders last and capped, so the
    // bound cannot cut the field that identifies the failure.
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      ...Array.from(
        { length: 50 },
        (_, i) => `    at frame${i} (${'/deep'.repeat(40)}.ts:1:1)`,
      ),
    ].join('\n');

    logger.debug('test', 'long request metadata', {
      data: { password, error, runId: 'run-7' },
    });

    const payload = payloadOf(entries[0]);
    expect(payload).not.toContain('visible-secret-prefix');
    expect(payload).toContain('"password": "[redacted]"');
    expect(payload).toContain('"runId": "run-7"');
  });

  it.effect(
    'routes native Effect logs and nested spans through the redacting sink',
    () =>
      Effect.gen(function* () {
        const entries = captureEntries();
        const operation = Effect.fn('model.request')(function* () {
          yield* Effect.annotateCurrentSpan('runId', 'run-42');
          yield* Effect.annotateCurrentSpan(
            'authorization',
            `Bearer ${SECRET}`,
          );
          yield* Effect.logWarning('provider warning').pipe(
            Effect.annotateLogs({ runId: 'run-42', apiKey: SECRET }),
          );
        });

        yield* operation().pipe(
          Effect.withSpan('session.run'),
          Effect.provide(effectDiagnosticsLayer('Trace')),
        );

        const warning = entries.find((entry) => entry.level === 'WARN');
        expect(warning?.message).toBe('provider warning');
        // Identity rides the entry's annotations, not a channel argument. A tracer
        // span does not attribute a log entry: `spans` reads `CurrentLogSpans`.
        expect(warning?.annotations['runId']).toBe('run-42');
        const output = JSON.stringify(entries);
        expect(output).toContain('[redacted]');
        expect(output).not.toContain(SECRET);

        // The emission threshold is the only filter: a warning clears an
        // informational floor without any producer-side gate.
        entries.length = 0;
        yield* operation().pipe(Effect.provide(effectDiagnosticsLayer('Info')));
        expect(entries).toHaveLength(1);
        expect(entries[0]?.message).toBe('provider warning');
      }),
  );

  it('disposes a replaced sink exactly once', () => {
    const dispose = vi.fn();
    setLogSink({ write: vi.fn(), dispose });

    setLogSink(null);
    setLogSink(null);

    expect(dispose).toHaveBeenCalledOnce();
  });
});

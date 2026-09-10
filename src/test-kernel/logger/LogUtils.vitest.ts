import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink, type LogEntry } from '@logger/logSink';
import * as logger from '@logger/logUtils';
import * as rootsAccess from '@platform/workspaceRoots';
import type { WorkspaceRoots } from '@platform/workspaceRoots';

const SECRET = 'sk-proj-redaction-example-1234567890abcdef';

function enableDebugLogging(): void {
  vi.spyOn(rootsAccess, 'tryWorkspaceRoots').mockReturnValue({
    config: { get: () => true },
  } as unknown as WorkspaceRoots);
}

/** Install a capturing sink and return the entries it receives. */
function captureEntries(options?: { trusted: boolean }): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogSink({ write: (entry) => entries.push(entry) }, options);
  return entries;
}

/** The payload annotation a debug-mode entry carries, if any. */
function payloadOf(entry: LogEntry | undefined): string {
  return String(entry?.annotations['data'] ?? '');
}

describe('logUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLogSink(null);
  });

  it('keeps pre-platform error logging on the non-debug path', () => {
    vi.spyOn(rootsAccess, 'tryWorkspaceRoots').mockReturnValue(undefined);
    const entries = captureEntries();

    expect(() =>
      logger.error('startup', 'pre-init failure', { data: new Error('boom') }),
    ).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('ERROR');
  });

  it('carries the level and channel as fields rather than message text', () => {
    const entries = captureEntries();

    logger.warn('BoundChannel', 'bound warning');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'WARN',
      message: 'bound warning',
      annotations: { channel: 'BoundChannel' },
    });
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

  it('redacts serialized debug data before sending it to the sink', () => {
    enableDebugLogging();
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

  it('createLog binds its channel onto the same entry the free writers build', () => {
    enableDebugLogging();
    const entries = captureEntries();

    logger.createLog('BoundChannel').debug('with data', {
      data: { requestId: 'visible-request-id' },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.annotations['channel']).toBe('BoundChannel');
    expect(payloadOf(entries[0])).toContain(
      '"requestId": "visible-request-id"',
    );
  });

  it.effect(
    'routes native Effect logs and nested spans through the redacting sink',
    () =>
      Effect.gen(function* () {
        enableDebugLogging();
        const entries = captureEntries();
        const operation = Effect.fn('model.request')(function* () {
          yield* Effect.annotateCurrentSpan('executionId', 'run-42');
          yield* Effect.annotateCurrentSpan(
            'authorization',
            `Bearer ${SECRET}`,
          );
          yield* Effect.logWarning('provider warning').pipe(
            Effect.annotateLogs({ executionId: 'run-42', apiKey: SECRET }),
          );
        });

        yield* operation().pipe(
          Effect.withSpan('session.run'),
          Effect.provide(effectDiagnosticsLayer),
        );

        const warning = entries.find((entry) => entry.level === 'WARN');
        expect(warning?.message).toBe('provider warning');
        // Identity rides the entry's annotations, not a channel argument. A
        // tracer span does not attribute a log entry: `spans` reads
        // `CurrentLogSpans`.
        expect(warning?.annotations['executionId']).toBe('run-42');
        const output = JSON.stringify(entries);
        expect(output).toContain('[redacted]');
        expect(output).not.toContain(SECRET);

        vi.spyOn(rootsAccess, 'tryWorkspaceRoots').mockReturnValue(undefined);
        entries.length = 0;
        yield* operation().pipe(Effect.provide(effectDiagnosticsLayer));
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

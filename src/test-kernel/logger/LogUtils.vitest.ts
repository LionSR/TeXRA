import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logger from '@logger/logUtils';
import * as config from '@utils/config/configUtils';

const SECRET = 'sk-proj-redaction-example-1234567890abcdef';

function enableDebugLogging(): void {
  vi.spyOn(config, 'getConfig').mockReturnValue(true);
}

function captureLines(options?: { trusted: boolean }): string[] {
  const lines: string[] = [];
  logger.setOutputChannelFactory(
    () => ({
      appendLine(message: string) {
        lines.push(message);
      },
    }),
    options,
  );
  return lines;
}

describe('logUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logger.setOutputChannelFactory(null);
  });

  it('serializes self-referential array log data without recursing forever', () => {
    enableDebugLogging();
    const lines = captureLines();

    const data: unknown[] = [];
    data.push(data);

    logger.debug('test', 'cyclic array payload', { data });

    expect(lines.join('\n')).toContain('[Circular]');
  });

  it('does not mark repeated acyclic references as circular', () => {
    enableDebugLogging();
    const lines = captureLines();

    const shared = { value: 1 };

    logger.debug('test', 'shared payload', {
      data: { first: shared, second: shared },
    });

    const output = lines.join('\n');
    expect(output).not.toContain('[Circular]');
    expect(output).toContain('"first"');
    expect(output).toContain('"second"');
  });

  it('redacts lines sent to an output sink by default', () => {
    const lines = captureLines();

    logger.info('test', `OPENAI_API_KEY=${SECRET}`);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).toContain('OPENAI_API_KEY=[redacted]');
  });

  it('preserves the raw line for an explicitly trusted sink', () => {
    const lines = captureLines({ trusted: true });

    const rawMessage = `OPENAI_API_KEY=${SECRET}`;
    logger.info('test', rawMessage);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(rawMessage);
    expect(lines[0]).not.toContain('[redacted]');
  });

  it('redacts lines sent through the default console fallback', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.setOutputChannelFactory(null);

    logger.warn('test', `Authorization: Bearer ${SECRET}`);

    expect(consoleInfo).toHaveBeenCalledOnce();
    const output = String(consoleInfo.mock.calls[0]?.[0]);
    expect(output).not.toContain(SECRET);
    expect(output).toContain('Authorization: Bearer [redacted]');
  });

  it('redacts serialized debug data before sending it to the sink', () => {
    enableDebugLogging();
    const lines = captureLines();

    logger.debug('test', 'request metadata', {
      data: {
        authorization: `Bearer ${SECRET}`,
        password: 'correct horse battery staple',
        refreshToken: 'opaque-refresh-credential',
        requestId: 'visible-request-id',
      },
    });

    const output = lines.join('\n');
    expect(lines).toHaveLength(2);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('correct horse battery staple');
    expect(output).not.toContain('opaque-refresh-credential');
    expect(lines[1]).toContain('"authorization": "Bearer [redacted]"');
    expect(lines[1]).toContain('"password": "[redacted]"');
    expect(lines[1]).toContain('"refreshToken": "[redacted]"');
    expect(lines[1]).toContain('"requestId": "visible-request-id"');
  });

  it('disposes a shared underlying sink exactly once', () => {
    const dispose = vi.fn();
    const sink = { appendLine: vi.fn(), dispose };
    logger.setOutputChannelFactory(() => sink);

    logger.createChannelWriter('shared', false);
    logger.createChannelWriter('agent', true);
    logger.setOutputChannelFactory(null);

    expect(dispose).toHaveBeenCalledOnce();
  });
});

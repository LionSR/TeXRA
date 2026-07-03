import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logger from '@logger/logUtils';
import * as config from '@utils/config';

describe('logUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logger.setOutputChannelFactory(null);
  });

  it('serializes self-referential array log data without recursing forever', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue(true);
    const lines: string[] = [];
    logger.setOutputChannelFactory(() => ({
      appendLine(message: string) {
        lines.push(message);
      },
    }));

    const data: unknown[] = [];
    data.push(data);

    logger.debug('test', 'cyclic array payload', { data });

    expect(lines.join('\n')).toContain('[Circular]');
  });

  it('does not mark repeated acyclic references as circular', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue(true);
    const lines: string[] = [];
    logger.setOutputChannelFactory(() => ({
      appendLine(message: string) {
        lines.push(message);
      },
    }));

    const shared = { value: 1 };

    logger.debug('test', 'shared payload', {
      data: { first: shared, second: shared },
    });

    const output = lines.join('\n');
    expect(output).not.toContain('[Circular]');
    expect(output).toContain('"first"');
    expect(output).toContain('"second"');
  });
});

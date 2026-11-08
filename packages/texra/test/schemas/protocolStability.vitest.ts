// Third-party imports
import { describe, expect, it } from 'vitest';

import { PROTOCOL } from '@texra/controllers/server/protocol';

/**
 * The two procedures every build must keep: a client of any build reads a
 * service's hello and asks it to stop (`texra service stop`, the retire on
 * upgrade). Their shapes are pinned; the rest of the protocol is identified
 * by its digest (`PROTOCOL.digest`), which moves on its own.
 */
describe('service protocol stability', () => {
  it('keeps the hello and the stop at their pinned shapes', () => {
    expect({
      'service.hello': PROTOCOL.shapes['service.hello'],
      'service.stop': PROTOCOL.shapes['service.stop'],
    }).toEqual({
      'service.hello': 'ddbc64476a75',
      'service.stop': '8d19317aa364',
    });
  });
});

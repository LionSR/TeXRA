// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - test support
import { createFakeUIHosts } from '../support/FakeHosts';

describe('FakeHosts', () => {
  it('records prompt effects and returns queued responses', async () => {
    const hosts = createFakeUIHosts({
      promptResponses: ['Open'],
      confirmResponses: [false],
      inputResponses: ['paper'],
    });

    const selected = await hosts.prompt.info('Ready', {
      items: ['Open', 'Dismiss'],
    });
    const confirmed = await hosts.prompt.confirm('Delete file?');
    const input = await hosts.prompt.input({ prompt: 'Name' });

    assert.equal(selected, 'Open');
    assert.equal(confirmed, false);
    assert.equal(input, 'paper');
    assert.deepEqual(hosts.prompt.messages, [
      {
        kind: 'info',
        message: 'Ready',
        options: { items: ['Open', 'Dismiss'] },
      },
    ]);
    assert.deepEqual(hosts.prompt.confirms, [
      { message: 'Delete file?', options: undefined },
    ]);
    assert.deepEqual(hosts.prompt.inputs, [{ options: { prompt: 'Name' } }]);
  });

  it('defaults unqueued confirmations to cancel', async () => {
    const hosts = createFakeUIHosts();

    assert.equal(await hosts.prompt.confirm('Continue?'), false);
    assert.deepEqual(hosts.prompt.confirms, [
      { message: 'Continue?', options: undefined },
    ]);
  });

  it('records opener and diff effects', async () => {
    const hosts = createFakeUIHosts({
      proposedDiffContent: { '/tmp/proposed.tex': 'edited' },
    });

    await hosts.externalOpener.openExternal('https://texra.ai');
    assert.deepEqual(hosts.externalOpener.externalUrls, ['https://texra.ai']);

    const session = await hosts.diff.openDiff(
      { filePath: '/tmp/original.tex' },
      { filePath: '/tmp/proposed.tex' },
      'Changes',
    );
    await hosts.diff.revealFirstChange(session, 12);
    await hosts.diff.closeDiff(session);

    assert.equal(await hosts.diff.readProposedContent(session), 'edited');
    assert.deepEqual(hosts.diff.opened, [
      {
        original: { filePath: '/tmp/original.tex' },
        proposed: { filePath: '/tmp/proposed.tex' },
        title: 'Changes',
      },
    ]);
    assert.deepEqual(hosts.diff.revealed, [{ session, line: 12 }]);
    assert.deepEqual(hosts.diff.closed, [session]);
  });

  it('fails when proposed diff content is unavailable', async () => {
    const hosts = createFakeUIHosts();
    const session = await hosts.diff.openDiff(
      { filePath: '/tmp/original.tex' },
      { filePath: '/tmp/missing.tex' },
      'Changes',
    );

    await assert.rejects(
      hosts.diff.readProposedContent(session),
      /No proposed diff content/,
    );
  });
});

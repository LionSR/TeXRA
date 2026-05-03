// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test support
import { FakeTerminalHandle, createFakeUIHosts } from '../support/FakeHosts';

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

  it('does not return queued input rejected by validation', async () => {
    const hosts = createFakeUIHosts({ inputResponses: ['bad-name'] });

    const input = await hosts.prompt.input({
      prompt: 'Name',
      validateInput: (value) =>
        value.includes(' ') ? undefined : 'Enter at least two words',
    });

    assert.equal(input, undefined);
    assert.deepEqual(hosts.prompt.inputs, [
      {
        options: {
          prompt: 'Name',
          validateInput: hosts.prompt.inputs[0]?.options.validateInput,
        },
      },
    ]);
  });

  it('records opener, clipboard, terminal, and diff effects', async () => {
    const hosts = createFakeUIHosts({
      clipboardText: 'initial',
      proposedDiffContent: { '/tmp/proposed.tex': 'edited' },
    });

    await hosts.externalOpener.openExternal('https://texra.ai');
    await hosts.externalOpener.openPath('/workspace/main.pdf');
    assert.deepEqual(hosts.externalOpener.externalUrls, ['https://texra.ai']);
    assert.deepEqual(hosts.externalOpener.paths, ['/workspace/main.pdf']);

    assert.equal(await hosts.clipboard.readText(), 'initial');
    await hosts.clipboard.writeText('copied');
    assert.equal(await hosts.clipboard.readText(), 'copied');
    assert.deepEqual(hosts.clipboard.writes, ['copied']);

    const terminal = hosts.terminal.createTerminal({ name: 'Setup' });
    terminal.show(true);
    terminal.sendText('npm install', true);
    const foundTerminal = hosts.terminal.findTerminal('Setup');
    const listedTerminals = hosts.terminal.getTerminals();
    assert.ok(foundTerminal);
    assert.notEqual(foundTerminal, terminal);
    assert.equal(foundTerminal.name, 'Setup');
    assert.equal(listedTerminals.length, 1);
    assert.notEqual(listedTerminals[0], terminal);
    assert.equal(listedTerminals[0]?.name, 'Setup');
    assert.ok(terminal instanceof FakeTerminalHandle);
    assert.deepEqual(terminal.showCalls, [{ preserveFocus: true }]);
    assert.deepEqual(terminal.sentText, [
      { text: 'npm install', shouldExecute: true },
    ]);
    terminal.dispose();
    assert.equal(hosts.terminal.findTerminal('Setup'), undefined);
    assert.deepEqual(hosts.terminal.getTerminals(), []);

    const session = await hosts.diff.openDiff(
      { filePath: '/tmp/original.tex' },
      { filePath: '/tmp/proposed.tex' },
      'Changes',
      { preserveFocus: false },
    );
    await hosts.diff.revealFirstChange(session, 12);
    await hosts.diff.closeDiff(session);

    assert.equal(
      await hosts.diff.readProposedContent(session, 'fallback'),
      'edited',
    );
    assert.deepEqual(hosts.diff.opened, [
      {
        original: { filePath: '/tmp/original.tex' },
        proposed: { filePath: '/tmp/proposed.tex' },
        title: 'Changes',
        options: { preserveFocus: false },
      },
    ]);
    assert.deepEqual(hosts.diff.revealed, [{ session, line: 12 }]);
    assert.deepEqual(hosts.diff.closed, [session]);
  });
});

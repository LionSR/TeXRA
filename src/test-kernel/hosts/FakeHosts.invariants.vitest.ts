// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import {
  FakeTerminalHandle,
  createFakeUIHosts,
} from '../../test/support/FakeHosts';

describe('FakeHosts kernel invariants', () => {
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

    expect(selected).toBe('Open');
    expect(confirmed).toBe(false);
    expect(input).toBe('paper');
    expect(hosts.prompt.messages).toEqual([
      {
        kind: 'info',
        message: 'Ready',
        options: { items: ['Open', 'Dismiss'] },
      },
    ]);
    expect(hosts.prompt.confirms).toEqual([
      { message: 'Delete file?', options: undefined },
    ]);
    expect(hosts.prompt.inputs).toEqual([{ options: { prompt: 'Name' } }]);
  });

  it('treats unqueued confirmations as cancellation', async () => {
    const hosts = createFakeUIHosts();

    expect(await hosts.prompt.confirm('Continue?')).toBe(false);
    expect(hosts.prompt.confirms).toEqual([
      {
        message: 'Continue?',
        options: undefined,
      },
    ]);
  });

  it('does not return queued input rejected by validation', async () => {
    const hosts = createFakeUIHosts({ inputResponses: ['bad-name'] });

    const input = await hosts.prompt.input({
      prompt: 'Name',
      validateInput: (value) =>
        value.includes(' ') ? undefined : 'Enter at least two words',
    });

    expect(input).toBeUndefined();
    expect(hosts.prompt.inputs[0]?.options.prompt).toBe('Name');
  });

  it('records opener, clipboard, terminal, and diff effects', async () => {
    const hosts = createFakeUIHosts({
      clipboardText: 'initial',
      proposedDiffContent: { '/tmp/proposed.tex': 'edited' },
    });

    await hosts.externalOpener.openExternal('https://texra.ai');
    await hosts.externalOpener.openPath('/workspace/main.pdf');

    expect(await hosts.clipboard.readText()).toBe('initial');
    await hosts.clipboard.writeText('copied');
    expect(await hosts.clipboard.readText()).toBe('copied');

    const terminal = hosts.terminal.createTerminal({ name: 'Setup' });
    terminal.show(true);
    terminal.sendText('npm install', true);

    const foundTerminal = hosts.terminal.findTerminal('Setup');
    const listedTerminals = hosts.terminal.getTerminals();

    expect(foundTerminal).toBeTruthy();
    expect(foundTerminal).not.toBe(terminal);
    expect(foundTerminal?.name).toBe('Setup');
    expect(listedTerminals).toHaveLength(1);
    expect(listedTerminals[0]).not.toBe(terminal);
    expect(listedTerminals[0]?.name).toBe('Setup');
    expect(terminal).toBeInstanceOf(FakeTerminalHandle);

    expect({
      externalUrls: hosts.externalOpener.externalUrls,
      openedPaths: hosts.externalOpener.paths,
      clipboardWrites: hosts.clipboard.writes,
      terminalShows: terminal.showCalls,
      terminalCommands: terminal.sentText,
    }).toEqual({
      externalUrls: ['https://texra.ai'],
      openedPaths: ['/workspace/main.pdf'],
      clipboardWrites: ['copied'],
      terminalShows: [{ preserveFocus: true }],
      terminalCommands: [{ text: 'npm install', shouldExecute: true }],
    });

    terminal.dispose();

    expect(hosts.terminal.findTerminal('Setup')).toBeUndefined();
    expect(hosts.terminal.getTerminals()).toEqual([]);

    const session = await hosts.diff.openDiff(
      { filePath: '/tmp/original.tex' },
      { filePath: '/tmp/proposed.tex' },
      'Changes',
      { preserveFocus: false },
    );
    await hosts.diff.revealFirstChange(session, 12);
    await hosts.diff.closeDiff(session);

    expect(await hosts.diff.readProposedContent(session, 'fallback')).toBe(
      'edited',
    );
    expect(hosts.diff.opened).toEqual([
      {
        original: { filePath: '/tmp/original.tex' },
        proposed: { filePath: '/tmp/proposed.tex' },
        title: 'Changes',
        options: { preserveFocus: false },
      },
    ]);
    expect(hosts.diff.revealed).toEqual([{ session, line: 12 }]);
    expect(hosts.diff.closed).toEqual([session]);
  });
});

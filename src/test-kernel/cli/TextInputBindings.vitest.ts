// Audit of the declarative text-input keymap: every chord routes to exactly
// the binding that declares it, every table entry is reachable (no dead or
// shadowed "excessive" entries), and the /help docs render from the same
// table so they cannot drift from the implementation.

import { describe, expect, it } from 'vitest';

import { formatSlashCommandHelp } from '@cli/chat/tui/commands/helpText';
import {
  matchTextInputBinding,
  TEXT_INPUT_BINDINGS,
  textInputEditingHelp,
  type TextInputKey,
} from '@cli/chat/tui/input/textInputBindings';

interface Probe {
  readonly chord: string;
  readonly input: string;
  readonly key: TextInputKey;
  /** Expected binding label, or undefined when the chord must stay unbound
   *  (owned by a stateful handler or passed through as text). */
  readonly binding: string | undefined;
}

const PROBES: readonly Probe[] = [
  // Word deletes — alias spellings must shadow the plain deletes.
  {
    chord: 'Ctrl-W',
    input: 'w',
    key: { ctrl: true },
    binding: 'Ctrl-W / Alt-Backspace',
  },
  {
    chord: 'Ctrl-W raw byte',
    input: '\u0017',
    key: {},
    binding: 'Ctrl-W / Alt-Backspace',
  },
  {
    chord: 'Alt-Backspace meta flag',
    input: '',
    key: { backspace: true, meta: true },
    binding: 'Ctrl-W / Alt-Backspace',
  },
  {
    chord: 'Alt-Backspace raw ESC+DEL',
    input: '\u001B\u007F',
    key: {},
    binding: 'Ctrl-W / Alt-Backspace',
  },
  { chord: 'Alt-D', input: 'd', key: { meta: true }, binding: 'Alt-D' },
  { chord: 'Alt-D raw ESC d', input: '\u001Bd', key: {}, binding: 'Alt-D' },
  // Word moves — modified arrows must shadow the plain arrows.
  {
    chord: 'Alt-B',
    input: 'b',
    key: { meta: true },
    binding: 'Alt-B / Ctrl-←',
  },
  {
    chord: 'Ctrl-←',
    input: '',
    key: { leftArrow: true, ctrl: true },
    binding: 'Alt-B / Ctrl-←',
  },
  {
    chord: 'Alt-←',
    input: '',
    key: { leftArrow: true, meta: true },
    binding: 'Alt-B / Ctrl-←',
  },
  {
    chord: 'Alt-F',
    input: 'f',
    key: { meta: true },
    binding: 'Alt-F / Ctrl-→',
  },
  {
    chord: 'Ctrl-→',
    input: '',
    key: { rightArrow: true, ctrl: true },
    binding: 'Alt-F / Ctrl-→',
  },
  // Plain editing keys.
  {
    chord: 'Backspace',
    input: '',
    key: { backspace: true },
    binding: 'Backspace',
  },
  { chord: 'Delete', input: '', key: { delete: true }, binding: 'Delete' },
  { chord: '←', input: '', key: { leftArrow: true }, binding: '←' },
  { chord: '→', input: '', key: { rightArrow: true }, binding: '→' },
  { chord: 'Home', input: '', key: { home: true }, binding: 'Home / Ctrl-A' },
  {
    chord: 'Ctrl-A raw byte',
    input: '\u0001',
    key: {},
    binding: 'Home / Ctrl-A',
  },
  { chord: 'End', input: '', key: { end: true }, binding: 'End / Ctrl-E' },
  {
    chord: 'Ctrl-E raw byte',
    input: '\u0005',
    key: {},
    binding: 'End / Ctrl-E',
  },
  { chord: 'Ctrl-U raw byte', input: '\u0015', key: {}, binding: 'Ctrl-U' },
  { chord: 'Ctrl-K', input: 'k', key: { ctrl: true }, binding: 'Ctrl-K' },
  { chord: 'Ctrl-K raw byte', input: '\u000B', key: {}, binding: 'Ctrl-K' },
  // Chords the keymap must NOT own.
  { chord: 'printable a', input: 'a', key: {}, binding: undefined },
  {
    chord: 'Ctrl-V (image paste)',
    input: '\u0016',
    key: {},
    binding: undefined,
  },
  {
    chord: 'Ctrl-B (unbound)',
    input: 'b',
    key: { ctrl: true },
    binding: undefined,
  },
  {
    chord: 'Alt-P (stream shortcut)',
    input: 'p',
    key: { meta: true },
    binding: undefined,
  },
];

describe('text input keymap', () => {
  it('routes every probe chord to exactly its declared binding', () => {
    const routed = PROBES.map((probe) => ({
      chord: probe.chord,
      binding: matchTextInputBinding(probe.input, probe.key)?.keys,
    }));

    expect(routed).toEqual(
      PROBES.map((probe) => ({ chord: probe.chord, binding: probe.binding })),
    );
  });

  it('has no unreachable (excessive) entries — every binding is probed', () => {
    const probed = new Set(PROBES.map((probe) => probe.binding));
    const unreachable = TEXT_INPUT_BINDINGS.map((b) => b.keys).filter(
      (keys) => !probed.has(keys),
    );

    expect(unreachable).toEqual([]);
  });

  it('declares each chord label once', () => {
    const labels = TEXT_INPUT_BINDINGS.map((binding) => binding.keys);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it('renders the advertised bindings into /help from the same table', () => {
    const help = textInputEditingHelp();

    expect(formatSlashCommandHelp([])).toContain(help);
    for (const binding of TEXT_INPUT_BINDINGS) {
      if (binding.advertise) {
        expect(help).toContain(`\`${binding.keys}\``);
      }
    }
  });
});

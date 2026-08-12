import { signal } from '@lit-labs/signals';

import { ANSI_ESCAPE_START, isCsiFinalByte } from '@cli/runtime/ansiEscapes';

interface SgrStripState {
  pending: string;
}

export function stripAnsiSgrChunk(text: string, state: SgrStripState): string {
  const input = `${state.pending}${text}`;
  state.pending = '';

  let output = '';
  for (let index = 0; index < input.length;) {
    if (input[index] !== ANSI_ESCAPE_START) {
      output += input[index];
      index += 1;
      continue;
    }

    const next = input[index + 1];
    if (next === undefined) {
      state.pending = input.slice(index);
      break;
    }
    if (next !== '[') {
      output += input.slice(index, index + 2);
      index += 2;
      continue;
    }

    let end = index + 2;
    while (end < input.length && !isCsiFinalByte(input.charCodeAt(end))) {
      end += 1;
    }
    if (end >= input.length) {
      state.pending = input.slice(index);
      break;
    }

    const sequence = input.slice(index, end + 1);
    if (input[end] !== 'm') output += sequence;
    index = end + 1;
  }

  return output;
}

function chunkText(chunk: unknown): string | undefined {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  return undefined;
}

function writeCallback(args: readonly unknown[]): (() => void) | undefined {
  const callback = args.at(-1);
  return typeof callback === 'function' ? (callback as () => void) : undefined;
}

export function sgrStrippingWriteStream<T extends NodeJS.WriteStream>(
  stream: T,
): T {
  const state: SgrStripState = { pending: '' };
  const write = stream.write.bind(stream) as (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ) => boolean;
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === 'write') {
        return (chunk: unknown, ...args: unknown[]) => {
          const text = chunkText(chunk);
          if (text === undefined) return write(chunk as Uint8Array, ...args);

          const output = stripAnsiSgrChunk(text, state);
          if (output === '') {
            writeCallback(args)?.();
            return true;
          }
          return write(output, ...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}

// Session color mode, set by tuiOutputStreamForColor (sole decision point).
// Inverse caret falls back to a glyph when SGR is stripped; signal (not bare
// let) matches other CLI TUI publish-once state.
const tuiColorEnabled = signal(true);

export function isTuiColorEnabled(): boolean {
  return tuiColorEnabled.get();
}

export function tuiOutputStreamForColor<T extends NodeJS.WriteStream>(
  stream: T,
  colorEnabled: boolean,
): T {
  tuiColorEnabled.set(colorEnabled);
  return colorEnabled ? stream : sgrStrippingWriteStream(stream);
}

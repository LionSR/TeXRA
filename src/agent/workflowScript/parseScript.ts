import * as vm from 'node:vm';

import { z } from 'zod';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { WorkflowScriptMetaSchema, type WorkflowScriptMeta } from './types';

export class WorkflowScriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptParseError';
  }
}

export interface ParsedWorkflowScript {
  meta: WorkflowScriptMeta;
  /** Script source with the meta `export` keyword stripped, sandbox-ready. */
  body: string;
}

const META_PATTERN = /export\s+const\s+meta\s*=\s*\{/;

/**
 * Statically validates a workflow script: extracts and zod-parses the
 * `export const meta = {...}` literal (evaluated in a bare realm so it must
 * be self-contained), and rejects module imports. The body is not executed.
 *
 * All structural scanning (import ban, meta anchoring, brace matching) runs
 * on a masked copy of the source with string/comment contents blanked, so
 * prose like "you can mention require() here" in prompts or comments is not
 * a false positive. The import ban is an early, readable error, not the
 * security boundary — the sandbox realm has no `require`, and dynamic
 * `import()` fails there at runtime (no dynamic-import callback is wired).
 */
export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const masked = maskStringsAndComments(source);

  if (
    /(^|[^.\w])require\s*\(/.test(masked) ||
    /^\s*import[\s(]/m.test(masked) ||
    /[^\w.]import\s*\(/.test(masked)
  ) {
    throw new WorkflowScriptParseError(
      'Workflow scripts cannot import modules; use only the injected primitives (agent, parallel, pipeline, concat, log, phase, args).',
    );
  }

  const match = META_PATTERN.exec(masked);
  if (!match || /\S/.test(masked.slice(0, match.index))) {
    throw new WorkflowScriptParseError(
      'Workflow script must begin with `export const meta = { name, description, ... }` (only whitespace/comments may precede it).',
    );
  }
  // META_PATTERN ends in `\{`, so the literal opens at the match's last char.
  const braceStart = match.index + match[0].length - 1;
  const braceEnd = findMatchingBrace(masked, braceStart);
  if (braceEnd < 0) {
    throw new WorkflowScriptParseError(
      'Unterminated meta object literal in workflow script.',
    );
  }

  const literal = source.slice(braceStart, braceEnd + 1);
  let rawMeta: unknown;
  try {
    // Bare realm with code generation disabled: a non-literal meta
    // (references to script identifiers, eval tricks) fails here. The JSON
    // round-trip runs INSIDE the vm timeout so accessor tricks (e.g.
    // `get name() { while (true) {} }`) hang the sandboxed evaluation, not
    // the host-side Zod parse, and what reaches the host is plain data.
    rawMeta = new vm.Script(`JSON.parse(JSON.stringify((${literal})))`, {
      filename: 'workflow-meta.js',
    }).runInContext(
      vm.createContext({}, { codeGeneration: { strings: false, wasm: false } }),
      { timeout: 250 },
    );
  } catch (error) {
    throw new WorkflowScriptParseError(
      `meta must be a pure object literal: ${toErrorMessage(error)}`,
    );
  }
  const parsed = WorkflowScriptMetaSchema.safeParse(rawMeta);
  if (!parsed.success) {
    throw new WorkflowScriptParseError(
      `Invalid workflow meta: ${z.prettifyError(parsed.error)}`,
    );
  }

  const body =
    source.slice(0, match.index) +
    source.slice(match.index).replace(/^export\s+/, '');
  return { meta: parsed.data, body };
}

/**
 * Returns the source with the contents of string literals (including whole
 * template literals) and comments blanked to spaces, preserving length and
 * newlines so indices map 1:1 onto the original. Code inside template
 * interpolations is blanked too — an import hidden there still fails at
 * runtime in the sandbox, so the static ban deliberately stays simple.
 */
function maskStringsAndComments(source: string): string {
  // split('') keeps UTF-16 units so indices map 1:1 onto the original.
  // [...source] would iterate code points and shorten the mask after any
  // astral character (e.g. an emoji in a meta description), shifting every
  // later match/brace offset.
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', i);
      const stop = newline < 0 ? source.length : newline;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close < 0 ? source.length : close + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const end = skipString(source, i);
      blank(i + 1, end - 1);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Finds the brace matching `masked[openIndex]`. Operates on masked source,
 * where string/comment contents are already spaces, so a plain depth count
 * suffices. Returns -1 if unbalanced.
 */
function findMatchingBrace(masked: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === '{') depth += 1;
    if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Returns the index just past the closing quote of the string at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

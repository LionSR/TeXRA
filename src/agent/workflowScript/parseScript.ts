import * as vm from 'node:vm';

import { z } from 'zod';

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
 */
export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  if (
    /(^|[^.\w])require\s*\(/.test(source) ||
    /^\s*import[\s(]/m.test(source) ||
    /[^\w.]import\s*\(/.test(source)
  ) {
    throw new WorkflowScriptParseError(
      'Workflow scripts cannot import modules; use only the injected primitives (agent, parallel, pipeline, concat, log, phase, args).',
    );
  }

  const match = META_PATTERN.exec(source);
  if (!match) {
    throw new WorkflowScriptParseError(
      'Workflow script must begin with `export const meta = { name, description, ... }`.',
    );
  }
  const braceStart = source.indexOf('{', match.index + match[0].length - 1);
  const braceEnd = findMatchingBrace(source, braceStart);
  if (braceEnd < 0) {
    throw new WorkflowScriptParseError(
      'Unterminated meta object literal in workflow script.',
    );
  }

  const literal = source.slice(braceStart, braceEnd + 1);
  let rawMeta: unknown;
  try {
    // Bare realm: a non-literal meta (references to script variables,
    // function calls on script identifiers) fails with ReferenceError here.
    rawMeta = new vm.Script(`(${literal})`, {
      filename: 'workflow-meta.js',
    }).runInContext(vm.createContext({}), { timeout: 250 });
  } catch (error) {
    throw new WorkflowScriptParseError(
      `meta must be a pure object literal: ${error instanceof Error ? error.message : String(error)}`,
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
 * Finds the brace matching `source[openIndex]`, skipping string literals
 * and comments. Returns -1 if unbalanced.
 */
function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(source, i);
      continue;
    }
    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', i);
      i = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
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

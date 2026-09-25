import * as vm from 'node:vm';

import {
  parse,
  tokenizer,
  type AnyNode,
  type Position,
  type Program,
} from 'acorn';
import { full as walkAst } from 'acorn-walk';
import { z } from 'zod';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { WorkflowScriptMetaSchema, type WorkflowScriptMeta } from './types';

export interface ParsedWorkflowScript {
  meta: WorkflowScriptMeta;
  /** Script source with the meta `export` keyword stripped, sandbox-ready. */
  body: string;
}

interface ExportedMetaDeclaration {
  exportStart: number;
  declarationStart: number;
  literalStart: number;
  literalEnd: number;
}

/**
 * The body runs as a generator function, so it is parsed as one: the leading
 * `export` keyword is blanked (offsets stay put) and the source wrapped in a
 * generator declaration on the same first line, so reported lines match.
 */
const BODY_PREFIX = 'function* workflow() {';

const MODULE_LOADING_ERROR =
  'Workflow scripts cannot import modules; use only the injected primitives (agent, all, forEach, attempt, retry, timeout, log, phase, args, files).';

function parseProgram(source: string): {
  program: Program;
  exportRange: readonly [number, number] | undefined;
} {
  let exportRange: readonly [number, number] | undefined;
  try {
    const first = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }).getToken();
    if (first.type.keyword === 'export') exportRange = [first.start, first.end];
  } catch {
    // Unreadable tokens are reported by the parse below, with a location.
  }
  const blanked =
    exportRange === undefined
      ? source
      : source.slice(0, exportRange[0]) +
        ' '.repeat(exportRange[1] - exportRange[0]) +
        source.slice(exportRange[1]);
  const wrapped = `${BODY_PREFIX}${blanked}\n}`;
  try {
    return {
      program: parse(wrapped, { ecmaVersion: 'latest', sourceType: 'module' }),
      exportRange,
    };
  } catch (error) {
    const { pos, loc } = error as { pos?: number; loc?: Position };
    if (pos !== undefined && wrapped.startsWith('import', pos)) {
      throw new Error(MODULE_LOADING_ERROR);
    }
    const where =
      loc === undefined
        ? ''
        : ` (${loc.line}:${loc.line === 1 ? loc.column - BODY_PREFIX.length : loc.column})`;
    const reason = toErrorMessage(error).replace(/ \(\d+:\d+\)$/, '');
    if (/\bawait\b/.test(reason)) {
      throw new Error(
        `Invalid workflow script syntax: ${reason}${where}. Workflow scripts are generators: write \`yield* agent(...)\` and \`yield* all([...])\`, not \`await\`.`,
      );
    }
    throw new Error(`Invalid workflow script syntax: ${reason}${where}`);
  }
}

function rejectsModuleLoading(program: Program): boolean {
  const isRequire = (node: AnyNode): boolean =>
    node.type === 'Identifier' && node.name === 'require';

  let rejected = false;
  walkAst(program, (node: AnyNode) => {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ImportExpression' ||
      (node.type === 'CallExpression' && isRequire(node.callee)) ||
      (node.type === 'TaggedTemplateExpression' && isRequire(node.tag))
    ) {
      rejected = true;
    }
  });
  return rejected;
}

function exportedMetaDeclaration(
  program: Program,
  exportRange: readonly [number, number] | undefined,
): ExportedMetaDeclaration | undefined {
  const wrapper = program.body[0];
  if (exportRange === undefined || wrapper?.type !== 'FunctionDeclaration') {
    return undefined;
  }
  const declaration = wrapper.body.body[0];
  if (
    declaration?.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const'
  ) {
    return undefined;
  }
  const [meta] = declaration.declarations;
  if (
    declaration.declarations.length !== 1 ||
    meta?.id.type !== 'Identifier' ||
    meta.id.name !== 'meta' ||
    meta.init?.type !== 'ObjectExpression'
  ) {
    return undefined;
  }
  const offset = BODY_PREFIX.length;
  return {
    exportStart: exportRange[0],
    declarationStart: declaration.start - offset,
    literalStart: meta.init.start - offset,
    literalEnd: meta.init.end - offset,
  };
}

/**
 * Statically validates a workflow script: parses it as a generator body,
 * extracts and zod-parses the `export const meta = {...}` literal (evaluated
 * in a bare realm so it must be self-contained), and rejects module imports.
 * The body is not executed. An `await` gets a pointed syntax error.
 *
 * Acorn owns tokenization and structural scanning so strings, comments, regex
 * literals, and modern syntax cannot confuse the import ban or meta offsets.
 * The import ban is an early, readable error, not the security boundary — the
 * sandbox realm has no `require`, and dynamic `import()` fails there at runtime
 * (no dynamic-import callback is wired).
 */
export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const { program, exportRange } = parseProgram(source);

  if (rejectsModuleLoading(program)) {
    throw new Error(MODULE_LOADING_ERROR);
  }

  const metaDeclaration = exportedMetaDeclaration(program, exportRange);
  if (!metaDeclaration) {
    throw new Error(
      'Workflow script must begin with `export const meta = { name, description, ... }` (only whitespace/comments may precede it).',
    );
  }

  const literal = source.slice(
    metaDeclaration.literalStart,
    metaDeclaration.literalEnd,
  );
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
    throw new Error(
      `meta must be a pure object literal: ${toErrorMessage(error)}`,
    );
  }
  const parsed = WorkflowScriptMetaSchema.safeParse(rawMeta);
  if (!parsed.success) {
    throw new Error(`Invalid workflow meta: ${z.prettifyError(parsed.error)}`);
  }

  const body =
    source.slice(0, metaDeclaration.exportStart) +
    source.slice(metaDeclaration.declarationStart);
  return { meta: parsed.data, body };
}

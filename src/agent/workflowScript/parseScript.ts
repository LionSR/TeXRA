import * as vm from 'node:vm';

import { parse, type Node, type Program } from 'acorn';
import { full as walkAst } from 'acorn-walk';
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

interface ExportedMetaDeclaration {
  exportStart: number;
  declarationStart: number;
  literalStart: number;
  literalEnd: number;
}

function parseProgram(source: string): Program {
  try {
    return parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw new WorkflowScriptParseError(
      `Invalid workflow script syntax: ${toErrorMessage(error)}`,
    );
  }
}

function rejectsModuleLoading(program: Program): boolean {
  let rejected = false;
  walkAst(program, (node: Node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
      rejected = true;
      return;
    }
    const moduleLoad = node as Node & {
      callee?: Node & { name?: string };
      tag?: Node & { name?: string };
    };
    if (
      (node.type === 'CallExpression' &&
        moduleLoad.callee?.type === 'Identifier' &&
        moduleLoad.callee.name === 'require') ||
      (node.type === 'TaggedTemplateExpression' &&
        moduleLoad.tag?.type === 'Identifier' &&
        moduleLoad.tag.name === 'require')
    ) {
      rejected = true;
    }
  });
  return rejected;
}

function exportedMetaDeclaration(
  program: Program,
): ExportedMetaDeclaration | undefined {
  const first = program.body[0];
  if (first?.type !== 'ExportNamedDeclaration' || !first.declaration) {
    return undefined;
  }
  const declaration = first.declaration;
  if (
    declaration.type !== 'VariableDeclaration' ||
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
  return {
    exportStart: first.start,
    declarationStart: declaration.start,
    literalStart: meta.init.start,
    literalEnd: meta.init.end,
  };
}

/**
 * Statically validates a workflow script: extracts and zod-parses the
 * `export const meta = {...}` literal (evaluated in a bare realm so it must
 * be self-contained), and rejects module imports. The body is not executed.
 *
 * Acorn owns tokenization and structural scanning so strings, comments, regex
 * literals, and modern syntax cannot confuse the import ban or meta offsets.
 * The import ban is an early, readable error, not the security boundary — the
 * sandbox realm has no `require`, and dynamic `import()` fails there at runtime
 * (no dynamic-import callback is wired).
 */
export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const program = parseProgram(source);

  if (rejectsModuleLoading(program)) {
    throw new WorkflowScriptParseError(
      'Workflow scripts cannot import modules; use only the injected primitives (agent, parallel, log, phase, args, files).',
    );
  }

  const metaDeclaration = exportedMetaDeclaration(program);
  if (!metaDeclaration) {
    throw new WorkflowScriptParseError(
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
    source.slice(0, metaDeclaration.exportStart) +
    source.slice(metaDeclaration.declarationStart);
  return { meta: parsed.data, body };
}

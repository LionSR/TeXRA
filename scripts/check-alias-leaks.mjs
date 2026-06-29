#!/usr/bin/env node
/* global console, process, URL */
/**
 * check-alias-leaks.mjs — alias-closure gate for the `@texra/core` SDK surface.
 *
 * Sibling to scripts/check-runtime-boundaries.mjs. That script forbids
 * host/controller code from deep-importing internals (a regex pass over import
 * specifiers). THIS script closes the hole that regex pass cannot see: a
 * runtime export that *re-exports an internal type* under a new name, e.g.
 *
 *     // src/agent/runtime/executionRequests.ts
 *     export type RuntimeTaskState = TaskState;   // TaskState is INTERNAL
 *
 * The import lint is green (the host imports `@agent/runtime/executionRequests`,
 * an allowed path) yet the internal `TaskState` shape has leaked onto the SDK
 * surface verbatim. Renaming a symbol is not encapsulating it.
 *
 * Two detectors, both type-checker-grounded (the `typescript` compiler API is
 * already a dependency; `ts-morph` is intentionally NOT added — swap to its
 * Project / getAliasedSymbol wrappers if it ever lands). Membership is decided
 * by SYMBOL IDENTITY, not by name: the flow-local `AgentCategory`
 * (agentCreatorFlow.ts) is a different declaration from the published
 * `@shared/schemas/agent` `AgentCategory`, so a bare name check would
 * false-negative that leak. The resolved-type walk pierces type operators, so
 * `Parameters<typeof loadAgents>[0]` (→ internal LoadAgentsOptions) and
 * `Awaited<ReturnType<typeof computeAgentOptionsData>>` (→ internal
 * AgentOptionsDataPayload) are caught, not just bare `= TaskState`.
 *
 *   A. ALIAS-LEAK — every `export type X = <RHS>` (and `export { Y } from '…'`
 *      re-export) in src/agent/runtime/* whose RHS transitively references a
 *      *named* type whose declaration is NOT re-exported from the published
 *      barrel packages/core/src/index.ts. A re-alias of a *published* type
 *      (`= AgentConfig`) is NOT a leak — convenience re-exports of the public
 *      surface are style, not encapsulation breaks.
 *
 *   B. SIGNATURE-LEAK — every type/interface re-exported from the barrel (the
 *      PUBLISHED surface only) whose member or call-signature parameter is typed
 *      by an internal named type. Catches RunAgentOptions.onBeforeWaiting (→
 *      internal ToolUseBeforeWaitingCallback) and AgentRunHandle =
 *      Pick<ExecutionHandle, … | 'runtimeHost' | …> (→ internal ExecutionHandle).
 *      Benign published projections are suppressed via the audited ALLOWLIST —
 *      every entry must carry a justification. Deep-importable-UNPUBLISHED
 *      runtime interfaces are intentionally OUT of scope here (only the barrel
 *      surface is gated), matching the reconciliation's KEEP set.
 *
 * The four gold-standard delete-wholesale shim modules are skip-listed: their
 * internal-aliasing exports die WITH the module in the GS shim-delete PRD, so
 * converting them now is wasted work. Remove an entry once GS Step 3 deletes
 * that module, so a regression can never reintroduce it.
 *
 * Exit 0 = closure holds. Exit 1 = at least one leak (printed to stderr).
 * Wire into package.json next to check:runtime-boundaries:
 *     "check:alias-leaks": "node scripts/check-alias-leaks.mjs",
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const RUNTIME_DIR = join(REPO_ROOT, 'src/agent/runtime');
const BARREL = join(REPO_ROOT, 'packages/core/src/index.ts');
const TSCONFIG = join(REPO_ROOT, 'tsconfig.json');

// Gold-standard delete-wholesale modules (2026-06-29-prd-runtime-gold-standard
// :242-243,289-290). Their internal-aliasing exports are NOT converted — they
// vanish with the module in GS Step 3. Drop entries here as GS deletes them.
const SKIP_MODULES = new Set([
  'runCoordinatorCommands.ts',
  'executionQueries.ts',
  'streamControl.ts',
  'modelSwitch.ts',
]);

// Detector-B audited exceptions: `${PublishedTypeName}#${internalRefName}`.
// A published member may legitimately name a hidden-zone type only if listed
// here WITH a justification. The two SDK-1a RE-TYPE targets (onBeforeWaiting,
// AgentRunHandle) are deliberately ABSENT so they fail until re-typed.
const ALLOWLIST = new Map([
  // Example (none active): ['SomePublicType#SomeInternal', 'why it is safe'],
]);

// Detector B only treats a published member as a SIGNATURE-LEAK when the type it
// names is declared in an explicitly-HIDDEN implementation zone — the flow and
// tool internals the SDK boundary is encapsulating. The published surface
// legitimately composes domain vocabulary that the barrel exposes at the
// aggregate level (the AgentEvent union, the Platform port facade, AgentTrace
// options, storage metas) without re-exporting every leaf; those are NOT leaks.
const HIDDEN_ZONES = ['/src/agent/implementations/', '/src/tools/'];
// Forced seeds: confirmed leaks whose internal type is NOT in a hidden zone
// (AgentRunHandle's concrete ExecutionHandle lives under src/agent/runtime).
// Guarantees CI catches the named RE-TYPE targets even if zone tuning drifts.
const FORCED_SIGNATURE_LEAKS = new Set([
  'RunAgentOptions#ToolUseBeforeWaitingCallback',
  'ExecuteAgentOptions#ToolUseBeforeWaitingCallback',
  'AgentRunHandle#ExecutionHandle',
  'AgentRunHandle#AgentExecutionHandle',
]);

// ── TypeScript program over the runtime surface + the barrel ──
function loadCompilerOptions() {
  const raw = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    raw.config,
    ts.sys,
    dirname(TSCONFIG),
  );
  const options = parsed.options;
  // Custom rootNames: don't let project settings fight a typecheck-only pass.
  options.noEmit = true;
  options.skipLibCheck = true;
  options.composite = false;
  options.incremental = false;
  options.declaration = false;
  delete options.tsBuildInfoFile;
  delete options.outDir;
  return options;
}

function collectTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectTsFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const rootNames = [...collectTsFiles(RUNTIME_DIR), BARREL];
const program = ts.createProgram(rootNames, loadCompilerOptions());
const checker = program.getTypeChecker();

// ── Published target set: the real declarations the barrel re-exports ──
function unalias(sym) {
  let s = sym;
  while (s && s.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(s);
    if (!next || next === s) break;
    s = next;
  }
  return s;
}

const publishedTargets = new Set();
{
  const barrelSource = program.getSourceFile(BARREL);
  const barrelSymbol =
    barrelSource && checker.getSymbolAtLocation(barrelSource);
  if (!barrelSymbol) {
    console.error(
      `alias-leaks: cannot resolve barrel module symbol at ${BARREL}`,
    );
    process.exit(2);
  }
  for (const exp of checker.getExportsOfModule(barrelSymbol)) {
    publishedTargets.add(unalias(exp));
  }
}

const LIB_OR_DEP = /[\\/](node_modules|typescript[\\/]lib)[\\/]/;

// A symbol is a flaggable internal leak when it names a repo-local TYPE
// declaration that the barrel does not re-export. Identity-based, not name-based.
function isInternalLeak(symbol) {
  const sym = unalias(symbol);
  if (!sym) return false;
  if (sym.flags & ts.SymbolFlags.TypeParameter) return false;
  const TYPEISH =
    ts.SymbolFlags.Interface |
    ts.SymbolFlags.TypeAlias |
    ts.SymbolFlags.Class |
    ts.SymbolFlags.Enum;
  if (!(sym.flags & TYPEISH)) return false;
  if (!sym.name || sym.name.startsWith('__')) return false; // anonymous object types
  const decls = sym.declarations ?? [];
  if (decls.length === 0) return false;
  const inRepo = decls.some((d) => {
    const f = d.getSourceFile().fileName;
    return !LIB_OR_DEP.test(f) && f.startsWith(REPO_ROOT);
  });
  if (!inRepo) return false; // Omit/Pick/Parameters/Record and other lib globals
  return !publishedTargets.has(sym);
}

// Collect every named type symbol referenced inside a type node — both the
// syntactic references (catches Omit<Internal,…>, bare = Internal, and a
// distinct same-named decl like the flow-local AgentCategory) and the resolved
// type behind operators (catches Parameters<typeof f>[0] → Internal).
function collectReferencedTypeSymbols(typeNode) {
  const found = new Set();
  const visitAst = (node) => {
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName)
        ? node.typeName.right
        : node.typeName;
      const sym = checker.getSymbolAtLocation(name);
      if (sym) found.add(sym);
    }
    ts.forEachChild(node, visitAst);
  };
  visitAst(typeNode);
  try {
    const resolved = checker.getTypeFromTypeNode(typeNode);
    const visitType = (t, depth) => {
      if (!t || depth > 3) return;
      const s = t.aliasSymbol ?? t.symbol;
      if (s) found.add(s);
      if (
        typeof t.isUnionOrIntersection === 'function' &&
        t.isUnionOrIntersection()
      ) {
        for (const c of t.types) visitType(c, depth + 1);
      }
    };
    visitType(resolved, 0);
  } catch {
    /* indexed-access / conditional resolution can throw; AST walk still ran */
  }
  return found;
}

const violations = [];
function record(kind, node, message) {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  violations.push({
    kind,
    file: relative(REPO_ROOT, sf.fileName),
    line: line + 1,
    message,
  });
}

// Detector A gates the host-facing `Runtime*` command surface (the convention
// for the deep-importable runtime command modules). Non-`Runtime*` runtime
// internals (coordinators, ExecutionHandle, the registry's re-exports) are NOT
// the gated SDK surface — anything of theirs that actually reaches a host is
// caught by Detector B at the barrel.
const SURFACE_PREFIX = 'Runtime';

// An alias is a LEAK only when its RHS *is* (or thinly wraps) a single named
// type: a bare ref, an Omit/Pick/Exclude/Parameters/ReturnType/Awaited wrapper,
// an indexed access, `typeof X`, a function type, or an intersection that pins a
// bare internal ref (e.g. `InquiryActionMessage & { session? }`). A genuine
// object-literal or union-of-literals RHS is a real projection/result union
// (the KEEP class) and is left alone.
function isAliasLeakShape(node) {
  if (ts.isParenthesizedTypeNode(node)) return isAliasLeakShape(node.type);
  if (ts.isTypeReferenceNode(node)) return true;
  if (ts.isIndexedAccessTypeNode(node)) return true;
  if (ts.isTypeQueryNode(node)) return true;
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node))
    return true;
  if (ts.isIntersectionTypeNode(node)) {
    return node.types.some(
      (t) => ts.isTypeReferenceNode(t) || ts.isTypeQueryNode(t),
    );
  }
  return false; // TypeLiteral, UnionType, literal types → genuine projection/union
}

// ── Detector A: alias-leaks on the runtime `Runtime*` export surface ──
const runtimeFiles = new Set(collectTsFiles(RUNTIME_DIR));
for (const sf of program.getSourceFiles()) {
  if (!runtimeFiles.has(sf.fileName)) continue;
  if (SKIP_MODULES.has(basename(sf.fileName))) continue;

  sf.forEachChild((node) => {
    const exported =
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

    // `export type Runtime… = <RHS>`
    if (
      ts.isTypeAliasDeclaration(node) &&
      exported &&
      node.name.text.startsWith(SURFACE_PREFIX) &&
      isAliasLeakShape(node.type)
    ) {
      const self = unalias(checker.getSymbolAtLocation(node.name));
      const seen = new Set();
      for (const sym of collectReferencedTypeSymbols(node.type)) {
        const target = unalias(sym);
        if (target === self) continue; // self-reference noise
        if (!isInternalLeak(sym) || seen.has(target.name)) continue;
        seen.add(target.name);
        record(
          'ALIAS-LEAK',
          node,
          `export type ${node.name.text} re-exports internal type ` +
            `'${target.name}' (not on @texra/core barrel). ` +
            `Inline+unexport, author a projection, or publish the target.`,
        );
      }
    }

    // `export { Y as Runtime… } from '…internal…'`
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const spec of node.exportClause.elements) {
        if (!spec.name.text.startsWith(SURFACE_PREFIX)) continue;
        const sym = checker.getSymbolAtLocation(spec.name);
        if (sym && isInternalLeak(sym)) {
          record(
            'ALIAS-LEAK',
            spec,
            `re-export '${spec.name.text}' forwards internal type ` +
              `'${unalias(sym).name}' onto the runtime surface.`,
          );
        }
      }
    }
  });
}

// ── Detector B: signature-leaks on the PUBLISHED barrel surface ──
function inHiddenZone(sym) {
  return (unalias(sym).declarations ?? []).some((d) => {
    const f = d.getSourceFile().fileName.replace(/\\/g, '/');
    return HIDDEN_ZONES.some((z) => f.includes(z));
  });
}
for (const target of publishedTargets) {
  for (const decl of target.declarations ?? []) {
    if (!ts.isInterfaceDeclaration(decl) && !ts.isTypeAliasDeclaration(decl)) {
      continue;
    }
    const refs = collectReferencedTypeSymbols(
      ts.isTypeAliasDeclaration(decl) ? decl.type : decl,
    );
    const seen = new Set();
    for (const sym of refs) {
      const ref = unalias(sym);
      if (ref === target || !isInternalLeak(sym) || seen.has(ref.name))
        continue;
      const key = `${target.name}#${ref.name}`;
      if (!FORCED_SIGNATURE_LEAKS.has(key) && !inHiddenZone(sym)) continue;
      if (ALLOWLIST.has(key)) continue;
      seen.add(ref.name);
      record(
        'SIGNATURE-LEAK',
        decl,
        `published '${target.name}' exposes implementation-internal type ` +
          `'${ref.name}' in a member/parameter. Re-type to a value-only ` +
          `signature, or allowlist '${key}' with a justification.`,
      );
    }
  }
}

// ── Report ──
if (violations.length === 0) {
  console.log('alias-leaks: OK — @texra/core alias-closure holds.');
  process.exit(0);
}

const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}
console.error(
  `\nalias-leaks: ${violations.length} leak(s) on the @texra/core surface.\n`,
);
for (const [file, list] of [...byFile].sort()) {
  console.error(`  ${file}`);
  for (const v of list.sort((a, b) => a.line - b.line)) {
    console.error(`    ${v.line}: [${v.kind}] ${v.message}`);
  }
}
console.error('');
process.exit(1);

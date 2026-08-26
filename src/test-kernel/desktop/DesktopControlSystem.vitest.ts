// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.ts';

function read(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

function callsMethod(
  node: ts.Node,
  receiver: string,
  method: string,
): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === receiver &&
    node.expression.name.text === method
  );
}

function hasRendererUnsavedCloseVeto(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;

  function visit(node: ts.Node): void {
    if (
      callsMethod(node, 'window', 'addEventListener') &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'beforeunload'
    ) {
      const handler = node.arguments[1];
      if (
        handler &&
        (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        ts.isIdentifier(handler.parameters[0]?.name) &&
        ts.isBlock(handler.body)
      ) {
        const eventName = handler.parameters[0].name.text;
        const guard = handler.body.statements.find(ts.isIfStatement);
        const hasDirtyGuard =
          guard !== undefined &&
          ts.isPrefixUnaryExpression(guard.expression) &&
          guard.expression.operator === ts.SyntaxKind.ExclamationToken &&
          callsMethod(
            guard.expression.operand,
            'editorPane',
            'hasUnsavedChanges',
          ) &&
          ts.isReturnStatement(guard.thenStatement);
        const preventsDefault = handler.body.statements.some((statement) => {
          let callsPreventDefault = false;
          function findPreventDefault(descendant: ts.Node): void {
            if (callsMethod(descendant, eventName, 'preventDefault')) {
              callsPreventDefault = true;
            }
            ts.forEachChild(descendant, findPreventDefault);
          }
          findPreventDefault(statement);
          return callsPreventDefault;
        });
        found ||= hasDirtyGuard && preventsDefault;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

describe('desktop control system', () => {
  it('keeps embedded browsing behind an explicit URL and permission policy', () => {
    const browserViews = read(
      'packages/desktop/src/main/desktopBrowserViews.ts',
    );

    // Embedded browser views only load https URLs; external opens are
    // restricted to https/http/mailto, everything else is blocked loudly.
    expect(browserViews).toContain("parsed?.protocol === 'https:'");
    expect(browserViews).toContain("protocol === 'http:'");
    expect(browserViews).toContain("protocol === 'mailto:'");
    expect(browserViews).toContain('Blocked external browser URL');
    // Web content never gets device permissions without an explicit handler.
    expect(browserViews).toContain('setPermissionRequestHandler');
    expect(browserViews).toContain('setPermissionCheckHandler');
  });

  it('vetoes renderer closes while the editor has unsaved changes', () => {
    const renderer = read('packages/desktop/src/renderer/main.ts');

    expect(hasRendererUnsavedCloseVeto(renderer)).toBe(true);
  });

  it('keeps editor dirtiness out of desktop IPC', () => {
    for (const source of [
      read('packages/desktop/src/main/index.ts'),
      read('packages/desktop/src/main/desktopWorkspaceIpc.ts'),
      read('packages/desktop/src/renderer/main.ts'),
      read('packages/desktop/src/shared/desktopWorkspaceMessages.ts'),
    ]) {
      expect(source).not.toContain('EDITOR_DIRTY_STATE');
    }
  });
});

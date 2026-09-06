import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Research utility: use the examined checkout for source and an installed
// TeXRA checkout for TypeScript. No production modules are executed.
const [repo, dependencyRoot = repo, output] = process.argv.slice(2);
if (!repo)
  throw new Error('Usage: node source-census.mjs REPO [DEPENDENCIES] [OUTPUT]');
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const ts = require('typescript');
const files = execFileSync('git', ['ls-files', 'src/agent/modelHandlers'], {
  cwd: repo,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((file) => file.endsWith('.ts'));
const imports = [];
const sizes = [];
for (const file of files) {
  const source = readFileSync(path.join(repo, file), 'utf8');
  sizes.push({
    file,
    physicalLines: source.split('\n').length - Number(source.endsWith('\n')),
  });
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push({
        file,
        specifier: statement.moduleSpecifier.text,
        typeOnly: statement.importClause?.isTypeOnly === true,
      });
    }
  }
}
const portPath = 'src/agent/types/IModelHandler.ts';
const port = ts.createSourceFile(
  portPath,
  readFileSync(path.join(repo, portPath), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const members = [];
function visit(node) {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    members.push(node.literal.text);
  ts.forEachChild(node, visit);
}
visit(port);
const domainEdges = imports.filter(({ specifier }) =>
  /^@(agent\/(core|runtime|trace)|latex|platform|auth|model)(?:\/|$)/u.test(
    specifier,
  ),
);
const result = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim(),
  method:
    'Tracked .ts files; physical lines include comments and blanks; static imports parsed with TypeScript AST. Type-only imports are reported, not counted as runtime dependencies.',
  handlerFiles: files.length,
  physicalLines: sizes.reduce((sum, row) => sum + row.physicalLines, 0),
  publicPortMemberCount: members.length,
  publicPortMembers: members,
  largestFiles: sizes
    .toSorted((a, b) => b.physicalLines - a.physicalLines)
    .slice(0, 12),
  domainEdges,
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (output) writeFileSync(output, json);
else process.stdout.write(json);

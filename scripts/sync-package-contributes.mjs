// Node.js imports
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { build } from 'esbuild';

// Code-generate the catalog-derived parts of the VS Code manifest
// (`contributes.commands`, `contributes.keybindings`) from the command catalog
// and `contributes.chatSkills` from the bundled skills on disk, so the
// manifest never has to be hand-edited; `contributes.configuration` is
// forbidden outright (native settings view). In `--check` mode this is the CI
// diff gate: it fails when the committed manifest drifts from either source.

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packagePath = path.join(rootDir, 'packages', 'extension', 'package.json');
const require = createRequire(import.meta.url);
const bundleDir = await mkdtemp(
  path.join(tmpdir(), 'texra-package-contributes-'),
);
let commandCatalog;
try {
  await build({
    absWorkingDir: rootDir,
    entryPoints: {
      commandCatalog: 'src/shared/commands/catalog.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outdir: bundleDir,
    tsconfig: 'tsconfig.json',
  });
  commandCatalog = require(path.join(bundleDir, 'commandCatalog.js'));
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}
const { packageCommandContributions, commandKeybindings } = commandCatalog;

// One chat skill per bundled `SKILL.md`: the core `resources/skills/<name>/`
// and each tool plugin's `resources/plugins/<id>/skills/<name>/`. The runtime
// pools these roots into one name-ordered bundled tier, which reads the same
// as one directory only while the names are disjoint, so a clash throws here.
const resourcesDir = path.join(rootDir, 'packages', 'extension', 'resources');

async function bundledSkillEntries(relativeDir) {
  const dir = path.join(resourcesDir, relativeDir);
  return (await readdir(dir, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(dir, entry.name, 'SKILL.md')),
    )
    .map((entry) => ({
      name: entry.name,
      path: `resources/${relativeDir}/${entry.name}/SKILL.md`,
    }));
}

const pluginSkillDirs = (
  await readdir(path.join(resourcesDir, 'plugins'), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => `plugins/${entry.name}/skills`);
const chatSkills = (
  await Promise.all(
    ['skills', ...pluginSkillDirs].map((dir) => bundledSkillEntries(dir)),
  )
)
  .flat()
  .toSorted((a, b) => a.name.localeCompare(b.name));
for (const [index, skill] of chatSkills.entries()) {
  if (chatSkills[index + 1]?.name === skill.name) {
    throw new Error(
      `Bundled skill "${skill.name}" is shipped twice (${skill.path} and ${chatSkills[index + 1].path}); core and plugin skill directory names must be disjoint.`,
    );
  }
}

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const check = process.argv.includes('--check');
const packageText = await readFile(packagePath, 'utf8');
const packageJson = JSON.parse(packageText);
if (packageJson.contributes?.configuration !== undefined) {
  throw new Error(
    'packages/extension/package.json must not contribute TeXRA settings; use the native TeXRA settings view.',
  );
}
const contributes = {
  ...packageJson.contributes,
  commands: packageCommandContributions,
  keybindings: commandKeybindings,
  chatSkills,
};
const nextPackageJson = {
  ...packageJson,
  contributes,
};
const nextPackageText = `${JSON.stringify(nextPackageJson, null, 2)}\n`;

if (check) {
  if (
    normalizeLineEndings(nextPackageText) !== normalizeLineEndings(packageText)
  ) {
    throw new Error(
      'packages/extension/package.json contributes.* is out of sync with the settings/command catalogs. Run npm run sync:package-contributes.',
    );
  }
  console.log('package.json contributes.* is in sync with the catalogs');
} else {
  await writeFile(packagePath, nextPackageText);
  console.log('Synced package.json contributes.* from the catalogs');
}

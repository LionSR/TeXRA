// Node.js imports
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

// Third-party imports
import { build } from 'esbuild';

// Code-generate the catalog-derived parts of the VS Code manifest
// (`contributes.commands`, `contributes.keybindings`,
// `contributes.menus.commandPalette`) from the command catalog and the
// extension's presentation of it (`packages/extension/src/commandManifest.ts`)
// and `contributes.chatSkills` from the bundled skills on disk, so the
// manifest never has to be hand-edited; `contributes.configuration` is
// forbidden outright (native settings view). In `--check` mode this is the CI
// diff gate: it fails when the committed manifest drifts from either source.

const rootDir = path.resolve(import.meta.dirname, '..');
const packagePath = path.join(rootDir, 'packages', 'extension', 'package.json');
const require = createRequire(import.meta.url);
const bundleDir = await mkdtemp(
  path.join(tmpdir(), 'texra-package-contributes-'),
);
let commandManifest;
try {
  await build({
    absWorkingDir: rootDir,
    entryPoints: {
      commandManifest: 'packages/extension/src/commandManifest.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outdir: bundleDir,
    tsconfig: 'tsconfig.json',
  });
  commandManifest = require(path.join(bundleDir, 'commandManifest.js'));
} finally {
  await rm(bundleDir, { recursive: true, force: true });
}
const {
  packageCommandContributions,
  packageCommandPalette,
  commandKeybindings,
} = commandManifest;

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
  .map((entry) => `plugins/${entry.name}/skills`)
  // A plugin's directory may hold other resources and no skills.
  .filter((dir) => existsSync(path.join(resourcesDir, dir)));
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

const {
  values: { check },
} = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { check: { type: 'boolean' } },
});
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
  menus: {
    ...packageJson.contributes?.menus,
    commandPalette: packageCommandPalette,
  },
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
      'packages/extension/package.json contributes.* is out of sync with the command catalog or the bundled skills. Run npm run sync:package-contributes.',
    );
  }
  console.log(
    'package.json contributes.* is in sync with the command catalog and the bundled skills',
  );
} else {
  await writeFile(packagePath, nextPackageText);
  console.log(
    'Synced package.json contributes.* from the command catalog and the bundled skills',
  );
}

// Publishes `@texra-ai/llm` and `@texra-ai/harness` to npm at their shared
// version, llm first: the harness names the llm version as its peer floor.
//
//   node packages/harness/scripts/publish-npm.mjs --tag <latest|preview> [--dry-run]
//
// Release CI runs it on an `sdk-vX.Y.Z` release over npm Trusted Publishing.
// pnpm packs (only it applies `publishConfig.exports` and resolves the
// `workspace:` and `catalog:` specifiers) and npm publishes each tarball. A
// version already on npm is skipped, so a failed run can be run again.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const distTag = values.tag;
if (distTag !== 'latest' && distTag !== 'preview') {
  console.error('Usage: publish-npm.mjs --tag <latest|preview> [--dry-run]');
  process.exit(1);
}
const dryRun = values['dry-run'];

const packagesRoot = fileURLToPath(new URL('../..', import.meta.url));
// In publish order.
const packages = ['llm', 'harness'].map((dir) => {
  const manifest = JSON.parse(
    readFileSync(join(packagesRoot, dir, 'package.json'), 'utf8'),
  );
  return { name: manifest.name, version: manifest.version };
});
const versions = new Set(packages.map((pkg) => pkg.version));
if (versions.size !== 1) {
  console.error(
    `The SDK packages share one version: ${packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}.`,
  );
  process.exit(1);
}

/** Run a command; a failure ends the publish with its output shown. */
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    console.error(
      `Failed: ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
    process.exit(result.status ?? 1);
  }
  return result.stdout;
};

/** Whether this exact version is on npm; a 404 is "no", any other failure ends the publish. */
const isPublished = ({ name, version }) => {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim() === version;
  if (/E404|404 Not Found/.test(result.stderr)) return false;
  console.error(`Failed to query ${name}@${version}:\n${result.stderr}`);
  process.exit(1);
};

const outDir = mkdtempSync(join(tmpdir(), 'texra-sdk-publish-'));
try {
  // Pack both before publishing either, so a pack failure publishes nothing.
  // Each pack runs its package's `prepack`, which builds what it publishes.
  const tarballs = packages.map((pkg) => {
    const dest = join(outDir, pkg.name.slice('@texra-ai/'.length));
    run(
      'corepack',
      ['pnpm', '--filter', pkg.name, 'pack', '--pack-destination', dest],
      { cwd: packagesRoot, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const [file] = readdirSync(dest).filter((entry) => entry.endsWith('.tgz'));
    const tarball = join(dest, file);
    const packedManifest = run('tar', [
      '-xOzf',
      tarball,
      'package/package.json',
    ]);
    const unresolved = packedManifest.match(/"(workspace|catalog):[^"]*"/);
    if (unresolved !== null) {
      console.error(
        `${pkg.name}: the packed package.json still names ${unresolved[0]}.`,
      );
      process.exit(1);
    }
    return { ...pkg, tarball };
  });

  console.log(
    `\nPublishing the SDK at ${packages[0].version} under dist-tag ${distTag}${dryRun ? ' (dry run)' : ''}.`,
  );
  for (const pkg of tarballs) {
    if (isPublished(pkg)) {
      console.log(`${pkg.name}@${pkg.version} is already on npm; skipped.`);
      continue;
    }
    // The dist-tag is always explicit: npm's default is `latest`, where a
    // preview must never land. Publishing a tarball runs no package script.
    const args = [
      'publish',
      pkg.tarball,
      '--access',
      'public',
      '--tag',
      distTag,
    ];
    if (dryRun) args.push('--dry-run');
    run('npm', args, { stdio: 'inherit' });
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

/** Build the fold probe against the pinned TeXRA checkout, without edits. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_COMMIT = '3958a96edd453938e023f163c1aa5b358854d89d';
const [checkoutArgument, outputArgument, ...extra] = process.argv.slice(2);
if (!checkoutArgument || extra.length > 0) {
  throw new Error(
    'Usage: node texra-fold-build.mjs <texra-checkout> [output.cjs]',
  );
}

const checkout = resolve(checkoutArgument);
const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (head !== SOURCE_COMMIT) {
  throw new Error(`Expected TeXRA ${SOURCE_COMMIT}; checkout is ${head}.`);
}
execFileSync('git', ['-C', checkout, 'diff', '--quiet', 'HEAD', '--']);

const outfile = outputArgument
  ? resolve(outputArgument)
  : join(await mkdtemp(join(tmpdir(), 'texra-fold-probe-')), 'probe.cjs');
if (!outfile.endsWith('.cjs')) {
  throw new Error('The output path must end in .cjs.');
}

const require = createRequire(join(checkout, 'package.json'));
const { build } = require('esbuild');
const schemaPath = join(checkout, 'src/shared/schemas/sessionEvent.ts');
await build({
  absWorkingDir: checkout,
  entryPoints: [
    fileURLToPath(new URL('./texra-fold-probe.ts', import.meta.url)),
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  tsconfig: join(checkout, 'tsconfig.json'),
  outfile,
  plugins: [
    {
      name: 'expose-private-schema-for-probe',
      setup(build) {
        build.onLoad({ filter: /sessionEvent\.ts$/ }, async (args) => {
          if (resolve(args.path) !== schemaPath) return;
          return {
            contents:
              (await readFile(args.path, 'utf8')) +
              '\nexport { SessionEventSchema };',
            loader: 'ts',
            resolveDir: dirname(args.path),
          };
        });
      },
    },
  ],
});
console.log(outfile);

import { execa } from 'execa';

const packageRoot = new URL('..', import.meta.url);
const runNodeScript = (script) =>
  execa('node', [`scripts/${script}`], {
    cwd: packageRoot,
    stdio: 'inherit',
  });

await runNodeScript('clean.mjs');
await runNodeScript('bundle.mjs');
await execa('tsc', ['-p', '../../tsconfig.build.json'], {
  cwd: packageRoot,
  stdio: 'inherit',
});
await runNodeScript('rewrite-declaration-aliases.mjs');
await runNodeScript('validate-artifacts.mjs');

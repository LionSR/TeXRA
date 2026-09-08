import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { linuxCompilerTargets, nativeCleanupTargets } from './targets.mjs';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    headers: { type: 'string' },
    'node-lib': { type: 'string' },
    cc: { type: 'string' },
  },
});
if (
  !values.target ||
  !nativeCleanupTargets.includes(values.target) ||
  !values.headers
) {
  throw new Error(
    'Usage: node scripts/native-cleanup/build.mjs --target <target> --headers <node/include/node> [--cc <compiler>] [--node-lib <node.lib>]',
  );
}
const source = dirname(fileURLToPath(import.meta.url));
const output = resolve(source, 'prebuilds', `${values.target}.node`);
mkdirSync(dirname(output), { recursive: true });
let compiler;
let args;
if (values.target.startsWith('win32-')) {
  if (!values['node-lib'])
    throw new Error('Windows builds require the target architecture node.lib');
  compiler = values.cc ?? 'cl.exe';
  args = [
    '/nologo',
    '/std:c11',
    '/O2',
    '/W4',
    '/WX',
    '/MT',
    '/LD',
    '/DNAPI_VERSION=8',
    '/D_WIN32_WINNT=0x0A00',
    `/I${resolve(values.headers)}`,
    'cleanup.c',
    'windows.c',
    'windows-loader.c',
    '/link',
    `/OUT:${output}`,
    '/DELAYLOAD:node.exe',
    resolve(values['node-lib']),
    'ntdll.lib',
    'kernel32.lib',
    'delayimp.lib',
  ];
} else {
  const linux = values.target.startsWith('linux-');
  compiler = values.cc ?? (linux ? 'zig' : 'clang');
  const targetArgs = linux
    ? [
        'cc',
        '-target',
        linuxCompilerTargets[values.target],
        '-D_POSIX_C_SOURCE=200809L',
        '-D_GNU_SOURCE',
        '-D_FILE_OFFSET_BITS=64',
      ]
    : [
        '-arch',
        values.target.endsWith('-x64') ? 'x86_64' : 'arm64',
        '-mmacosx-version-min=11.0',
        '-undefined',
        'dynamic_lookup',
      ];
  args = [
    ...targetArgs,
    '-std=c11',
    '-O2',
    '-shared',
    '-fPIC',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-DNAPI_VERSION=8',
    '-I',
    resolve(values.headers),
    'cleanup.c',
    'posix.c',
    '-o',
    output,
  ];
}
const result = spawnSync(compiler, args, { cwd: source, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(output);

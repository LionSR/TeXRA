/** Native Node hosts shipped by the universal CLI, SDK and extension artifacts. */
export const nativeCleanupTargets = [
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
  'win32-ia32',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-arm-gnu',
  'linux-ppc64-gnu',
  'linux-s390x-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
];

/** Node 22's supported GNU/Linux builds require glibc 2.28, not the CI host libc. */
export const linuxCompilerTargets = {
  'linux-x64-gnu': 'x86_64-linux-gnu.2.28',
  'linux-arm64-gnu': 'aarch64-linux-gnu.2.28',
  'linux-arm-gnu': 'arm-linux-gnueabihf.2.28',
  'linux-ppc64-gnu': 'powerpc64le-linux-gnu.2.28',
  'linux-s390x-gnu': 's390x-linux-gnu.2.28',
  'linux-x64-musl': 'x86_64-linux-musl',
  'linux-arm64-musl': 'aarch64-linux-musl',
};

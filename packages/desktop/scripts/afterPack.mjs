import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * electron-builder `afterPack` hook: makes node-pty's macOS `spawn-helper`
 * executable in the packed app, before the app is signed.
 *
 * node-pty starts every macOS terminal through that helper, and the published
 * package ships it without the executable bit, so each terminal fails with a
 * bare `posix_spawnp failed.` An installed app cannot repair its own copy: the
 * bundle may be read-only, and macOS refuses changes to a signed app.
 */
export default async function afterPack({
  appOutDir,
  electronPlatformName,
  packager,
}) {
  if (electronPlatformName !== 'darwin') return;
  const prebuilds = join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds',
  );
  for (const platformArch of await readdir(prebuilds)) {
    if (!platformArch.startsWith('darwin-')) continue;
    await chmod(join(prebuilds, platformArch, 'spawn-helper'), 0o755);
  }
}

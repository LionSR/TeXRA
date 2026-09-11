import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { reportCheckFailures } from './extension-package-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopPackageRoot =
  process.env.TEXRA_DESKTOP_INSTALLER_ROOT ??
  join(repoRoot, 'packages', 'desktop', 'dist-packaged');

// Keyed by process.platform. TEXRA_DESKTOP_INSTALLER_PLATFORM=all checks every
// platform at once (the publish job's merged download).
const platformRequirements = {
  darwin: {
    label: 'macOS',
    extensions: ['.dmg', '.zip'],
    iconPath: join(repoRoot, 'packages', 'desktop', 'build', 'icon.icns'),
  },
  win32: {
    label: 'Windows',
    extensions: ['.exe'],
    iconPath: join(repoRoot, 'packages', 'desktop', 'build', 'icon.ico'),
  },
  linux: {
    label: 'Linux',
    extensions: ['.AppImage', '.deb'],
    iconPath: join(repoRoot, 'packages', 'desktop', 'build', 'icon.png'),
  },
};

const requestedPlatform =
  process.env.TEXRA_DESKTOP_INSTALLER_PLATFORM ?? process.platform;
const platformKeys =
  requestedPlatform === 'all'
    ? Object.keys(platformRequirements)
    : [requestedPlatform];

if (!platformKeys.every((key) => Object.hasOwn(platformRequirements, key))) {
  console.error(
    `Unsupported desktop installer platform: ${requestedPlatform}. Expected darwin, win32, linux, or all.`,
  );
  process.exit(1);
}

async function collectTopLevelFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

const failures = [];
let files = [];

try {
  files = await collectTopLevelFiles(desktopPackageRoot);
} catch (error) {
  if (error?.code === 'ENOENT') {
    failures.push(
      `No desktop package output found under ${relative(repoRoot, desktopPackageRoot)}`,
    );
  } else {
    throw error;
  }
}

async function verifyIcon(requirement) {
  try {
    const iconStat = await stat(requirement.iconPath);
    if (iconStat.size === 0) {
      failures.push(
        `${requirement.label} installer icon is empty: ${relative(repoRoot, requirement.iconPath)}`,
      );
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      failures.push(
        `Missing ${requirement.label} installer icon: ${relative(repoRoot, requirement.iconPath)}`,
      );
    } else {
      throw error;
    }
  }
}

async function verifyPlatformArtifacts(platform) {
  const requirement = platformRequirements[platform];
  const matchedArtifacts = new Map();
  for (const extension of requirement.extensions) {
    matchedArtifacts.set(
      extension,
      files.filter((filePath) => filePath.endsWith(extension)),
    );
  }

  await verifyIcon(requirement);

  for (const [extension, artifacts] of matchedArtifacts.entries()) {
    if (artifacts.length === 0) {
      failures.push(
        `Missing ${requirement.label} installer artifact with extension ${extension}`,
      );
      continue;
    }

    for (const artifact of artifacts) {
      const artifactStat = await stat(artifact);
      if (artifactStat.size === 0) {
        failures.push(
          `Installer artifact is empty: ${relative(repoRoot, artifact)}`,
        );
      }
    }
  }

  return { requirement, matchedArtifacts };
}

const verifiedPlatforms = [];
for (const platform of platformKeys) {
  verifiedPlatforms.push(await verifyPlatformArtifacts(platform));
}

reportCheckFailures('Desktop installer artifact check', failures);

for (const { requirement, matchedArtifacts } of verifiedPlatforms) {
  console.log(`${requirement.label} desktop installer artifact check passed:`);
  console.log(`- ${relative(repoRoot, requirement.iconPath)}`);
  for (const artifacts of matchedArtifacts.values()) {
    for (const artifact of artifacts) {
      console.log(`- ${relative(repoRoot, artifact)}`);
    }
  }
}

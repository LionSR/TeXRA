import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopPackageRoot = join(
  repoRoot,
  'packages',
  'desktop',
  'dist-packaged',
);

const platformAlias = {
  darwin: 'mac',
  mac: 'mac',
  macos: 'mac',
  win: 'win',
  win32: 'win',
  windows: 'win',
  linux: 'linux',
};

const platformRequirements = {
  mac: {
    label: 'macOS',
    extensions: ['.dmg', '.zip'],
  },
  win: {
    label: 'Windows',
    extensions: ['.exe'],
  },
  linux: {
    label: 'Linux',
    extensions: ['.AppImage', '.deb'],
  },
};

const requestedPlatform =
  process.env.TEXRA_DESKTOP_INSTALLER_PLATFORM ?? process.platform;
const platformKey = platformAlias[requestedPlatform.toLowerCase()];

if (!platformKey) {
  console.error(
    `Unsupported desktop installer platform: ${requestedPlatform}. Expected mac, win, or linux.`,
  );
  process.exit(1);
}

async function collectFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function isInstallerArtifact(filePath, extension) {
  return filePath.endsWith(extension) && !filePath.endsWith('.blockmap');
}

const requirement = platformRequirements[platformKey];
const failures = [];
let files = [];

try {
  files = await collectFiles(desktopPackageRoot);
} catch (error) {
  if (error?.code === 'ENOENT') {
    failures.push(
      `No desktop package output found under ${relative(repoRoot, desktopPackageRoot)}`,
    );
  } else {
    throw error;
  }
}

const matchedArtifacts = new Map();
for (const extension of requirement.extensions) {
  matchedArtifacts.set(
    extension,
    files.filter((filePath) => isInstallerArtifact(filePath, extension)),
  );
}

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

if (failures.length > 0) {
  console.error('Desktop installer artifact check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`${requirement.label} desktop installer artifact check passed:`);
for (const artifacts of matchedArtifacts.values()) {
  for (const artifact of artifacts) {
    console.log(`- ${relative(repoRoot, artifact)}`);
  }
}

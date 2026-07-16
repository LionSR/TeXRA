import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopPackageRoot =
  process.env.TEXRA_DESKTOP_INSTALLER_ROOT ??
  join(repoRoot, 'packages', 'desktop', 'dist-packaged');
const electronBuilderConfigPath = join(
  repoRoot,
  'packages',
  'desktop',
  'electron-builder.yml',
);
const expectedReleaseOwner = 'texra-ai';
const expectedReleaseRepo = 'texra-desktop-releases';

const platformAlias = {
  all: 'all',
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
    updateMetadata: 'latest-mac.yml',
    updateExtensions: ['.zip'],
    iconPath: join(repoRoot, 'packages', 'desktop', 'build', 'icon.icns'),
  },
  win: {
    label: 'Windows',
    extensions: ['.exe'],
    updateMetadata: 'latest.yml',
    updateExtensions: ['.exe'],
    iconPath: join(repoRoot, 'packages', 'desktop', 'build', 'icon.ico'),
  },
  linux: {
    label: 'Linux',
    extensions: ['.AppImage', '.deb'],
    updateMetadata: 'latest-linux.yml',
    updateExtensions: ['.AppImage'],
    iconPath: join(repoRoot, 'packages', 'desktop', 'build', 'icon.png'),
  },
};

const requestedPlatform =
  process.env.TEXRA_DESKTOP_INSTALLER_PLATFORM ?? process.platform;
const platformKey = platformAlias[requestedPlatform.toLowerCase()];

if (!platformKey) {
  console.error(
    `Unsupported desktop installer platform: ${requestedPlatform}. Expected mac, win, linux, or all.`,
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

function isInstallerArtifact(filePath, extension) {
  return filePath.endsWith(extension) && !filePath.endsWith('.blockmap');
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

function getTopLevelYamlBlock(source, key) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (startIndex === -1) return '';

  const block = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function requireYamlValue(block, key, expectedValue) {
  const valuePattern = expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^\\s+${key}:\\s+${valuePattern}\\s*$`, 'm').test(block)) {
    failures.push(
      `Desktop release publish target must set ${key}: ${expectedValue} in ${relative(repoRoot, electronBuilderConfigPath)}`,
    );
  }
}

async function verifyPublishTarget() {
  let configText;
  try {
    configText = await readFile(electronBuilderConfigPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      failures.push(
        `Missing desktop electron-builder config: ${relative(repoRoot, electronBuilderConfigPath)}`,
      );
      return;
    }
    throw error;
  }

  const publishBlock = getTopLevelYamlBlock(configText, 'publish');
  if (publishBlock.length === 0) {
    failures.push(
      `Missing desktop release publish target in ${relative(repoRoot, electronBuilderConfigPath)}`,
    );
    return;
  }

  requireYamlValue(publishBlock, 'provider', 'github');
  requireYamlValue(publishBlock, 'owner', expectedReleaseOwner);
  requireYamlValue(publishBlock, 'repo', expectedReleaseRepo);
  requireYamlValue(publishBlock, 'private', 'false');
}

function getPlatformKeys() {
  return platformKey === 'all'
    ? Object.keys(platformRequirements)
    : [platformKey];
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

async function verifyUpdateMetadata(requirement, matchedArtifacts) {
  const metadataPath = join(desktopPackageRoot, requirement.updateMetadata);
  let metadata = '';
  try {
    metadata = await readFile(metadataPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      failures.push(
        `Missing ${requirement.label} update metadata: ${relative(repoRoot, metadataPath)}`,
      );
      return;
    }
    throw error;
  }

  if (metadata.trim().length === 0) {
    failures.push(
      `${requirement.label} update metadata is empty: ${relative(repoRoot, metadataPath)}`,
    );
    return;
  }

  for (const marker of ['sha512:', 'releaseDate:']) {
    if (!metadata.includes(marker)) {
      failures.push(
        `${requirement.label} update metadata is missing ${marker} in ${relative(repoRoot, metadataPath)}`,
      );
    }
  }

  const updateArtifacts = requirement.updateExtensions.flatMap(
    (extension) => matchedArtifacts.get(extension) ?? [],
  );
  if (updateArtifacts.length === 0) {
    failures.push(
      `${requirement.label} update metadata has no matching update-capable installer artifact`,
    );
    return;
  }

  const referencesUpdateArtifact = updateArtifacts.some((artifact) =>
    metadata.includes(basename(artifact)),
  );
  if (!referencesUpdateArtifact) {
    failures.push(
      `${requirement.label} update metadata does not reference a generated update artifact`,
    );
  }
}

async function verifyPlatformArtifacts(platform) {
  const requirement = platformRequirements[platform];
  const matchedArtifacts = new Map();
  for (const extension of requirement.extensions) {
    matchedArtifacts.set(
      extension,
      files.filter((filePath) => isInstallerArtifact(filePath, extension)),
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

  await verifyUpdateMetadata(requirement, matchedArtifacts);

  return { requirement, matchedArtifacts };
}

await verifyPublishTarget();

const verifiedPlatforms = [];
for (const platform of getPlatformKeys()) {
  verifiedPlatforms.push(await verifyPlatformArtifacts(platform));
}

if (failures.length > 0) {
  console.error('Desktop installer artifact check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

for (const { requirement, matchedArtifacts } of verifiedPlatforms) {
  console.log(`${requirement.label} desktop installer artifact check passed:`);
  console.log(
    `- release target: ${expectedReleaseOwner}/${expectedReleaseRepo}`,
  );
  console.log(`- ${relative(repoRoot, requirement.iconPath)}`);
  console.log(
    `- ${relative(repoRoot, join(desktopPackageRoot, requirement.updateMetadata))}`,
  );
  for (const artifacts of matchedArtifacts.values()) {
    for (const artifact of artifacts) {
      console.log(`- ${relative(repoRoot, artifact)}`);
    }
  }
}

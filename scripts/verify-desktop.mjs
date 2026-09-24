// One entry point for every desktop artifact check and Electron smoke run:
//
//   node scripts/verify-desktop.mjs <stage> [options]
//
// Stages:
//   electron-binary         the electron package resolved its platform binary
//   build-artifacts         `desktop:build` output under packages/desktop/dist
//   package                 the packaged Electron app (asar archive or app dir)
//   installers              electron-builder installer output
//   signing-env <mac|win>   signing credentials, and the Electron Builder
//                           config the packaging step must use
//   smoke-package [--app <executable>]
//                           launch the packaged app and wait for readiness
//   smoke-webviews          render the extension webviews in Electron
//
// A stage returns its check failures instead of exiting, so the reporter at
// the bottom of this file renders them and sets the exit code. Two paths keep
// their own exits, as they did before the collapse: a usage error (unknown
// stage, unsupported installer platform, missing `signing-env <mac|win>`)
// exits 1 where it is detected, and the `smoke-webviews` Electron harness
// throws its own labelled failure.
//
// Heavy dependencies (@electron/asar, @playwright/test, the esbuild-backed
// database fixture) load inside the stage that needs them, so no stage pays
// for another stage's dependencies.

// Node imports
import { appendFileSync, statSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Local imports - shared packaging invariants
import {
  readJson as readJsonSync,
  requiredMonacoWorkers,
  vscodeRuntimeImportPattern,
} from './extension-package-utils.mjs';
import { walkFiles } from './walkFiles.mjs';

// Local imports - smoke process helpers
import {
  appendBoundedLog,
  delay,
  formatExit,
  hasExited,
  stopChild,
  waitForTermination,
} from './smoke-process-utils.mjs';

// Local imports - Electron webview harness
import {
  renderSessionHarnessBridge,
  renderWebviewHtml,
  runElectronWebviewHarness,
} from './webview-electron-harness.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(repoRoot, 'packages', 'desktop');

function repoRelative(filePath) {
  return relative(repoRoot, filePath);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Stage: electron-binary
// ---------------------------------------------------------------------------

async function verifyElectronBinary() {
  const label = 'Desktop Electron binary check';
  const desktopRequire = createRequire(join(desktopRoot, 'package.json'));

  let electronBinaryPath;
  try {
    electronBinaryPath = desktopRequire('electron');
  } catch (error) {
    return {
      label,
      failures: [
        'The electron package did not install its platform binary. Run `corepack pnpm install --frozen-lockfile` with the root pnpm build-script policy applied.',
        errorMessage(error),
      ],
    };
  }

  if (
    typeof electronBinaryPath !== 'string' ||
    electronBinaryPath.length === 0
  ) {
    return {
      label,
      failures: ['The electron package did not resolve to a binary path.'],
    };
  }

  try {
    await access(electronBinaryPath);
  } catch (error) {
    return {
      label,
      failures: [
        `Resolved Electron binary does not exist: ${electronBinaryPath}`,
        errorMessage(error),
      ],
    };
  }

  return {
    label,
    summary: [`Desktop Electron binary check passed: ${electronBinaryPath}`],
  };
}

// ---------------------------------------------------------------------------
// Stage: build-artifacts
// ---------------------------------------------------------------------------

function fileExists(filePath) {
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

async function verifyBuildArtifacts() {
  const label = 'Desktop build artifact check';
  const failures = [];

  const packageJson = readJsonSync(join(desktopRoot, 'package.json'));
  const manifestMain = join(desktopRoot, packageJson.main);
  const requiredFiles = [
    manifestMain,
    join(desktopRoot, 'dist', 'preload', 'index.cjs'),
    join(desktopRoot, 'dist', 'renderer', 'index.html'),
  ];

  for (const filePath of requiredFiles) {
    if (!fileExists(filePath)) {
      failures.push(
        `Missing desktop build artifact: ${repoRelative(filePath)}`,
      );
    }
  }

  const rendererAssetsDir = join(desktopRoot, 'dist', 'renderer', 'assets');
  const rendererAssets = (await exists(rendererAssetsDir))
    ? walkFiles(rendererAssetsDir)
        .map((entry) => entry.absolutePath)
        .sort()
    : [];
  if (!rendererAssets.some((filePath) => filePath.endsWith('.js'))) {
    failures.push('Desktop renderer build did not emit a JavaScript asset.');
  }
  if (!rendererAssets.some((filePath) => filePath.endsWith('.css'))) {
    failures.push('Desktop renderer build did not emit a CSS asset.');
  }
  for (const workerName of requiredMonacoWorkers) {
    if (
      !rendererAssets.some((filePath) =>
        basename(filePath).includes(workerName),
      )
    ) {
      failures.push(
        `Desktop renderer build did not emit Monaco worker asset: ${workerName}`,
      );
    }
  }
  if (
    fileExists(manifestMain) &&
    vscodeRuntimeImportPattern.test(await readFile(manifestMain, 'utf8'))
  ) {
    failures.push(
      'Desktop main bundle contains a runtime import of the VS Code extension host module.',
    );
  }

  if (failures.length > 0) return { label, failures };

  const artifactList = [
    ...requiredFiles,
    ...rendererAssets.filter(
      (filePath) => filePath.endsWith('.js') || filePath.endsWith('.css'),
    ),
  ].map(repoRelative);

  return {
    label,
    summary: [
      'Desktop build artifact check passed:',
      ...artifactList.map((artifact) => `- ${artifact}`),
      '- Monaco worker assets are present',
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage: installers
// ---------------------------------------------------------------------------

// Keyed by process.platform. TEXRA_DESKTOP_INSTALLER_PLATFORM=all checks every
// platform at once (the publish job's merged download).
const platformRequirements = {
  darwin: {
    label: 'macOS',
    extensions: ['.dmg', '.zip'],
    iconPath: join(desktopRoot, 'build', 'icon.icns'),
  },
  win32: {
    label: 'Windows',
    extensions: ['.exe'],
    iconPath: join(desktopRoot, 'build', 'icon.ico'),
  },
  linux: {
    label: 'Linux',
    extensions: ['.AppImage', '.deb'],
    iconPath: join(desktopRoot, 'build', 'icon.png'),
  },
};

async function collectTopLevelFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) files.push(join(dir, entry.name));
  }
  return files.sort();
}

async function verifyInstallers() {
  const label = 'Desktop installer artifact check';
  const installerRoot =
    process.env.TEXRA_DESKTOP_INSTALLER_ROOT ??
    join(desktopRoot, 'dist-packaged');
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

  const failures = [];
  let files = [];
  try {
    files = await collectTopLevelFiles(installerRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      failures.push(
        `No desktop package output found under ${repoRelative(installerRoot)}`,
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
          `${requirement.label} installer icon is empty: ${repoRelative(requirement.iconPath)}`,
        );
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        failures.push(
          `Missing ${requirement.label} installer icon: ${repoRelative(requirement.iconPath)}`,
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
            `Installer artifact is empty: ${repoRelative(artifact)}`,
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

  if (failures.length > 0) return { label, failures };

  const summary = [];
  for (const { requirement, matchedArtifacts } of verifiedPlatforms) {
    summary.push(
      `${requirement.label} desktop installer artifact check passed:`,
      `- ${repoRelative(requirement.iconPath)}`,
    );
    for (const artifacts of matchedArtifacts.values()) {
      for (const artifact of artifacts) {
        summary.push(`- ${repoRelative(artifact)}`);
      }
    }
  }

  return { label, summary };
}

// ---------------------------------------------------------------------------
// Stage: signing-env
// ---------------------------------------------------------------------------

function present(name) {
  return Boolean(process.env[name]);
}

function collectMissing(names) {
  return names.filter((name) => !present(name));
}

function hasAny(names) {
  return names.some((name) => present(name));
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function verifyMacSigning(requireSigning) {
  const label = 'macOS desktop signing check';
  const certificateNames = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
  const apiKeyNames = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const appleIdNames = [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ];
  const keychainNames = ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'];
  const allNames = [
    ...certificateNames,
    ...apiKeyNames,
    ...appleIdNames,
    ...keychainNames,
  ];

  const certificateMissing = collectMissing(certificateNames);
  const apiKeyMissing = collectMissing(apiKeyNames);
  const appleIdMissing = collectMissing(appleIdNames);
  const keychainMissing = collectMissing(keychainNames);
  const hasCompleteNotarization =
    apiKeyMissing.length === 0 ||
    appleIdMissing.length === 0 ||
    keychainMissing.length === 0;
  const configured = certificateMissing.length === 0 && hasCompleteNotarization;
  const partial = hasAny(allNames) && !configured;

  if (configured) {
    writeOutput(
      'electron_builder_config',
      'electron-builder.signed.config.mjs',
    );
    writeOutput('signed', 'true');
    return {
      label,
      summary: [
        'macOS signing and notarization credentials are configured; using signed Electron Builder config.',
      ],
    };
  }

  writeOutput('electron_builder_config', 'electron-builder.yml');
  writeOutput('signed', 'false');

  if (partial || requireSigning) {
    const missing = [
      ...certificateMissing,
      ...(apiKeyMissing.length === apiKeyNames.length
        ? []
        : apiKeyMissing.map((name) => `${name} (API key notarization set)`)),
      ...(appleIdMissing.length === appleIdNames.length
        ? []
        : appleIdMissing.map((name) => `${name} (Apple ID notarization set)`)),
      ...(keychainMissing.length === keychainNames.length
        ? []
        : keychainMissing.map((name) => `${name} (keychain notarization set)`)),
    ];

    if (!hasCompleteNotarization) {
      missing.push(
        'one complete notarization set: APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, or APPLE_KEYCHAIN/APPLE_KEYCHAIN_PROFILE',
      );
    }

    return {
      label,
      failures: [
        'macOS desktop signing is incomplete.',
        ...missing.map((name) => `missing ${name}`),
      ],
    };
  }

  return {
    label,
    summary: [
      'macOS signing credentials are not configured; packaging will remain unsigned.',
    ],
  };
}

function verifyWindowsSigning(requireSigning) {
  const label = 'Windows desktop signing check';
  const azureConfigNames = [
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_PUBLISHER_NAME',
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ENDPOINT',
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME',
    'TEXRA_WINDOWS_AZURE_TRUSTED_SIGNING_ACCOUNT_NAME',
  ];
  const azureAuthNames = [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ];
  const allNames = [...azureConfigNames, ...azureAuthNames];
  const missing = collectMissing(allNames);
  const configured = missing.length === 0;
  const partial = hasAny(allNames) && !configured;

  if (configured) {
    writeOutput(
      'electron_builder_config',
      'electron-builder.signed.config.mjs',
    );
    writeOutput('signed', 'true');
    return {
      label,
      summary: [
        'Windows Azure Trusted Signing credentials are configured; using signed Electron Builder config.',
      ],
    };
  }

  writeOutput('electron_builder_config', 'electron-builder.yml');
  writeOutput('signed', 'false');

  if (partial || requireSigning) {
    return {
      label,
      failures: [
        'Windows desktop signing is incomplete.',
        ...missing.map((name) => `missing ${name}`),
      ],
    };
  }

  return {
    label,
    summary: [
      'Windows signing credentials are not configured; packaging will remain unsigned.',
    ],
  };
}

function verifySigningEnv(args) {
  const platform = args[0];
  if (!['mac', 'win'].includes(platform)) {
    console.error(
      'Usage: node scripts/verify-desktop.mjs signing-env <mac|win>',
    );
    process.exit(1);
  }

  const requireSigning = process.env.TEXRA_REQUIRE_DESKTOP_SIGNING === '1';
  return platform === 'mac'
    ? verifyMacSigning(requireSigning)
    : verifyWindowsSigning(requireSigning);
}

// ---------------------------------------------------------------------------
// Stage: package
// ---------------------------------------------------------------------------

const desktopIconPath = join(desktopRoot, 'build', 'icon.icns');
const bundledRuntimeResourceDirs = [
  'agents',
  'tool_use_agents',
  'skills',
  'plugins',
  'plugins/lean4/agents',
];
// The Codex and Claude Code SDKs each pull a per-platform package carrying a
// 250-410 MiB native CLI binary. The desktop app resolves a user-installed CLI
// at runtime (src/tools/codexImport.ts, src/tools/claudeAgentImport.ts), so
// none of these packages may ship inside the app — keeping the SDKs in
// devDependencies is what stops electron-builder from copying them.
const forbiddenNativeCliPackages = [
  {
    label: 'OpenAI Codex CLI',
    scope: '@openai',
    isPackageDirName: (name) => name === 'codex' || name.startsWith('codex-'),
    pnpmStorePrefix: '@openai+codex',
  },
  {
    label: 'Claude Code CLI',
    scope: '@anthropic-ai',
    isPackageDirName: (name) => name.startsWith('claude-agent-sdk'),
    pnpmStorePrefix: '@anthropic-ai+claude-agent-sdk',
  },
];
const nativeCliNodeModulesRoots = [
  'node_modules',
  'app.asar.unpacked/node_modules',
];
const desktopStartupForbiddenInputPackages = [
  {
    label: '@google/genai',
    patterns: [
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*@google\+genai[^/\\]*[/\\]node_modules[/\\])?@google[/\\]genai[/\\]/,
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*google-auth-library[^/\\]*[/\\]node_modules[/\\])?google-auth-library[/\\]/,
    ],
  },
  {
    label: 'OpenAI SDK',
    patterns: [
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*openai@[^/\\]*[/\\]node_modules[/\\])?openai[/\\]/,
    ],
  },
  {
    label: 'Anthropic SDK',
    patterns: [
      /(?:^|[/\\])node_modules[/\\](?:\.pnpm[/\\][^/\\]*@anthropic-ai\+sdk[^/\\]*[/\\]node_modules[/\\])?@anthropic-ai[/\\]sdk[/\\]/,
    ],
  },
];
const desktopStartupEntryPoints = new Set([
  'src/main/bootstrap.ts',
  'src/main/index.ts',
]);
const desktopStartupDynamicImportEntryPoints = new Set([
  'src/main/bootstrap.ts',
]);
const desktopStartupImportKinds = new Set([
  'dynamic-import',
  'import-statement',
]);

function normalizeMetafilePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isRelativeMetafileImportPath(path) {
  return (
    path === '.' ||
    path === '..' ||
    path.startsWith('./') ||
    path.startsWith('../')
  );
}

function resolveMetafileImportPath(outputPath, importPath) {
  const normalizedImportPath = importPath.replaceAll('\\', '/');
  if (isRelativeMetafileImportPath(normalizedImportPath)) {
    return normalizeMetafilePath(
      posix.normalize(
        posix.join(posix.dirname(outputPath), normalizedImportPath),
      ),
    );
  }
  return normalizeMetafilePath(posix.normalize(normalizedImportPath));
}

async function findPackagedApp(packageRoot, asar) {
  const pending = [{ path: packageRoot, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 8) continue;

    const asarPath = join(current.path, 'app.asar');
    if (await exists(asarPath)) {
      return createAsarAppReader(asarPath, asar);
    }

    const packageJsonPath = join(current.path, 'package.json');
    if (
      (await exists(packageJsonPath)) &&
      (await exists(join(current.path, 'dist', 'main', 'index.js')))
    ) {
      return createDirectoryAppReader(current.path);
    }

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      pending.push({
        path: join(current.path, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return null;
}

function normalizeAsarPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function mergeDirectoryEntries(...entryGroups) {
  return [...new Set(entryGroups.flat())].sort((left, right) =>
    left.localeCompare(right),
  );
}

function isDesktopStartupEntryPoint(entryPoint) {
  const normalizedEntryPoint = normalizeMetafilePath(entryPoint);
  return hasMetafileEntryPointSuffix(
    normalizedEntryPoint,
    desktopStartupEntryPoints,
  );
}

function hasMetafileEntryPointSuffix(
  normalizedEntryPoint,
  expectedEntryPoints,
) {
  for (const expectedEntryPoint of expectedEntryPoints) {
    if (
      normalizedEntryPoint === expectedEntryPoint ||
      normalizedEntryPoint.endsWith(`/${expectedEntryPoint}`)
    ) {
      return true;
    }
  }
  return false;
}

function shouldTraverseStartupImport(output, importedOutput) {
  if (importedOutput.external) return false;
  if (importedOutput.kind === 'import-statement') return true;
  if (importedOutput.kind !== 'dynamic-import') return false;

  return hasMetafileEntryPointSuffix(
    normalizeMetafilePath(output.entryPoint ?? ''),
    desktopStartupDynamicImportEntryPoints,
  );
}

function createAsarAppReader(asarPath, { extractFile, listPackage }) {
  const entryPathByNormalizedPath = new Map(
    listPackage(asarPath).map((entry) => [normalizeAsarPath(entry), entry]),
  );
  const entries = new Set(entryPathByNormalizedPath.keys());
  const resourceRoot = dirname(asarPath);
  function stripLeadingArchiveSeparator(path) {
    return path.replace(/^[/\\]+/, '');
  }
  function asarEntryPathCandidates(path) {
    const mappedPath = entryPathByNormalizedPath.get(normalizeAsarPath(path));
    return [
      mappedPath,
      mappedPath == null ? null : stripLeadingArchiveSeparator(mappedPath),
      mappedPath == null
        ? null
        : stripLeadingArchiveSeparator(mappedPath).replaceAll('\\', '/'),
      stripLeadingArchiveSeparator(path),
      stripLeadingArchiveSeparator(path).replaceAll('\\', '/'),
      path,
    ].filter((candidate, index, candidates) => {
      return candidate != null && candidates.indexOf(candidate) === index;
    });
  }
  function readAsarFile(path) {
    let lastError = null;
    for (const candidate of asarEntryPathCandidates(path)) {
      try {
        return extractFile(asarPath, candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  return {
    label: repoRelative(asarPath),
    async exists(path) {
      if (entries.has(normalizeAsarPath(path))) return true;
      return exists(join(resourceRoot, path));
    },
    async isDirectory(path) {
      const normalizedPath = normalizeAsarPath(path);
      for (const entry of entries) {
        if (entry.startsWith(`${normalizedPath}/`)) return true;
      }
      const entryStat = statSync(join(resourceRoot, path), {
        throwIfNoEntry: false,
      });
      return entryStat?.isDirectory() ?? false;
    },
    async readJson(path) {
      return JSON.parse(readAsarFile(path).toString('utf8'));
    },
    async readText(path) {
      return readAsarFile(path).toString('utf8');
    },
    async readBuffer(path) {
      if (entries.has(normalizeAsarPath(path))) {
        return readAsarFile(path);
      }
      return readFile(join(resourceRoot, path));
    },
    fsPath(path) {
      return join(resourceRoot, path);
    },
    async listDir(path) {
      const prefix = `${normalizeAsarPath(path)}/`;
      const asarEntries = [...entries]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .filter((entry) => entry && !entry.includes('/'))
        .map((entry) => basename(entry));
      try {
        const resourceEntries = await readdir(join(resourceRoot, path));
        return mergeDirectoryEntries(asarEntries, resourceEntries);
      } catch (error) {
        if (error?.code === 'ENOENT') return mergeDirectoryEntries(asarEntries);
        throw error;
      }
    },
  };
}

function createDirectoryAppReader(appRoot) {
  return {
    label: repoRelative(appRoot),
    exists(path) {
      return exists(join(appRoot, path));
    },
    async isDirectory(path) {
      const entryStat = statSync(join(appRoot, path), {
        throwIfNoEntry: false,
      });
      return entryStat?.isDirectory() ?? false;
    },
    readJson(path) {
      return readJsonFile(join(appRoot, path));
    },
    readText(path) {
      return readFile(join(appRoot, path), 'utf8');
    },
    readBuffer(path) {
      return readFile(join(appRoot, path));
    },
    async listDir(path) {
      try {
        return await readdir(join(appRoot, path));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
    fsPath(path) {
      return join(appRoot, path);
    },
  };
}

async function checkExists(app, path, label, failures) {
  if (await app.exists(path)) return;
  failures.push(`Missing ${label}: ${path}`);
}

async function checkNoVscodeRuntimeImport(app, failures) {
  for (const bundlePath of await collectMainJavaScriptBundles(app)) {
    const mainBundle = await app.readText(bundlePath);
    if (!vscodeRuntimeImportPattern.test(mainBundle)) continue;
    failures.push(
      `Packaged desktop main bundle contains a runtime import of the VS Code extension host module: ${bundlePath}`,
    );
  }
}

async function checkDesktopMainDynamicRequireShim(app, failures) {
  for (const bundlePath of await collectMainJavaScriptBundles(app)) {
    const mainBundle = await app.readText(bundlePath);
    if (!mainBundle.includes('Dynamic require of')) continue;
    if (
      mainBundle.includes('__texraCreateRequire(import.meta.url)') &&
      mainBundle.includes(
        'const __filename = __texraFileURLToPath(import.meta.url);',
      ) &&
      mainBundle.includes('const __dirname = __texraDirname(__filename);')
    ) {
      continue;
    }

    failures.push(
      `Packaged desktop main bundle contains esbuild dynamic require calls without the shared ESM CommonJS-globals shim: ${bundlePath}`,
    );
  }
}

async function collectMainJavaScriptBundles(app, dir = 'dist/main') {
  const entries = await app.listDir(dir);
  const bundles = [];
  for (const entry of entries) {
    const entryPath = posix.join(dir, entry);
    if (entry.endsWith('.js')) {
      bundles.push(entryPath);
    } else if (await app.isDirectory(entryPath)) {
      bundles.push(...(await collectMainJavaScriptBundles(app, entryPath)));
    }
  }
  return bundles.sort();
}

async function checkDesktopStartupBundles(app, failures) {
  const entryPath = 'dist/main/index.js';
  const metafilePath = 'dist/main/metafile.json';
  if (!(await app.exists(entryPath))) return;
  if (!(await app.exists(metafilePath))) {
    failures.push(
      `Packaged desktop app is missing the esbuild metafile used to verify startup imports: ${metafilePath}`,
    );
    return;
  }

  const metafile = await app.readJson(metafilePath);
  const outputByPath = new Map();
  for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
    outputByPath.set(normalizeMetafilePath(outputPath), output);
  }

  const pending = [];
  for (const [outputPath, output] of outputByPath) {
    if (isDesktopStartupEntryPoint(output.entryPoint ?? '')) {
      pending.push(outputPath);
    }
  }
  if (pending.length === 0) {
    failures.push(
      `Packaged desktop startup graph is missing expected esbuild entry points: ${[
        ...desktopStartupEntryPoints,
      ].join(', ')}`,
    );
    return;
  }

  const visitedOutputs = new Set();
  const startupInputsByForbiddenLabel = new Map();
  while (pending.length > 0) {
    const outputPath = pending.shift();
    if (!outputPath || visitedOutputs.has(outputPath)) continue;
    visitedOutputs.add(outputPath);

    const output = outputByPath.get(normalizeMetafilePath(outputPath));
    if (!output) {
      failures.push(
        `Packaged desktop startup bundle is missing from the esbuild metafile: ${outputPath}`,
      );
      continue;
    }

    for (const inputPath of Object.keys(output.inputs ?? {})) {
      const normalizedInput = normalizeMetafilePath(inputPath);
      for (const { label, patterns } of desktopStartupForbiddenInputPackages) {
        if (!patterns.some((pattern) => pattern.test(normalizedInput))) {
          continue;
        }
        const inputPaths = startupInputsByForbiddenLabel.get(label) ?? [];
        inputPaths.push(normalizedInput);
        startupInputsByForbiddenLabel.set(label, inputPaths);
      }
    }

    for (const importedOutput of output.imports ?? []) {
      if (!desktopStartupImportKinds.has(importedOutput.kind)) continue;
      if (!shouldTraverseStartupImport(output, importedOutput)) continue;
      const importedPath = resolveMetafileImportPath(
        outputPath,
        importedOutput.path,
      );
      if (outputByPath.has(importedPath)) pending.push(importedPath);
    }
  }

  for (const [label, inputPaths] of startupInputsByForbiddenLabel) {
    failures.push(
      `Packaged desktop startup graph eagerly includes provider SDK code (${label}): ${[
        ...new Set(inputPaths),
      ].join(', ')}`,
    );
  }
}

function dependencyPackageJsonPath(name) {
  return join('node_modules', name, 'package.json');
}

async function checkNoBundledNativeCliPayload(app, failures) {
  const bundled = [];

  for (const nodeModulesRoot of nativeCliNodeModulesRoots) {
    for (const cli of forbiddenNativeCliPackages) {
      for (const entry of await app.listDir(
        posix.join(nodeModulesRoot, cli.scope),
      )) {
        if (!cli.isPackageDirName(entry)) continue;
        bundled.push({
          cli,
          path: posix.join(nodeModulesRoot, cli.scope, entry),
        });
      }

      for (const entry of await app.listDir(
        posix.join(nodeModulesRoot, '.pnpm'),
      )) {
        if (!entry.startsWith(cli.pnpmStorePrefix)) continue;
        bundled.push({
          cli,
          path: posix.join(nodeModulesRoot, '.pnpm', entry),
        });
      }
    }
  }

  if (bundled.length === 0) return;

  const described = [];
  for (const { cli, path } of bundled) {
    const sizeBytes = await onDiskSize(app.fsPath(path));
    described.push(
      `${cli.label} at ${path}${sizeBytes == null ? '' : ` (${formatBytes(sizeBytes)})`}`,
    );
  }

  failures.push(
    'Packaged desktop app bundles native CLI payloads that must be installed ' +
      'by the user instead. Keep the SDKs in devDependencies so ' +
      `electron-builder never copies their platform packages: ${described.join('; ')}`,
  );
}

async function onDiskSize(path) {
  const entryStat = statSync(path, { throwIfNoEntry: false });
  if (entryStat == null) return null;
  if (!entryStat.isDirectory()) return entryStat.size;

  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childSize = await onDiskSize(join(path, entry.name));
    if (childSize != null) total += childSize;
  }
  return total;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function checkRuntimeDependencies(app, appPackageJson, failures) {
  const sourcePackageJson = await readJsonFile(
    join(desktopRoot, 'package.json'),
  );
  const sourceDependencies = sourcePackageJson.dependencies ?? {};
  const packagedDependencies = appPackageJson.dependencies ?? {};

  const missingDeclarations = [];
  const versionMismatches = [];
  for (const [name, version] of Object.entries(sourceDependencies)) {
    if (!Object.hasOwn(packagedDependencies, name)) {
      missingDeclarations.push(name);
    } else if (packagedDependencies[name] !== version) {
      versionMismatches.push(
        `${name} (expected ${version}, got ${packagedDependencies[name]})`,
      );
    }
  }
  if (missingDeclarations.length > 0) {
    failures.push(
      `Packaged app package.json is missing runtime dependency declarations: ${missingDeclarations.join(
        ', ',
      )}`,
    );
  }
  if (versionMismatches.length > 0) {
    failures.push(
      `Packaged app package.json has runtime dependency version mismatches: ${versionMismatches.join(
        ', ',
      )}`,
    );
  }

  const missingPackages = [];
  for (const name of Object.keys(sourceDependencies)) {
    if (!(await app.exists(dependencyPackageJsonPath(name)))) {
      missingPackages.push(name);
    }
  }
  if (missingPackages.length > 0) {
    failures.push(
      `Packaged app is missing runtime dependency packages: ${missingPackages.join(
        ', ',
      )}`,
    );
  }
}

async function checkBundledResources(app, failures) {
  for (const directoryName of bundledRuntimeResourceDirs) {
    const entries = await app.listDir(`resources/${directoryName}`);
    if (entries.length === 0) {
      failures.push(
        `Packaged app is missing bundled resource directory: resources/${directoryName}`,
      );
    }
  }

  await checkExists(
    app,
    'resources/traceViewer/index.html',
    'trace-viewer HTML template',
    failures,
  );
}

async function checkMonacoWorkerAssets(app, failures) {
  const assets = await app.listDir('dist/renderer/assets');
  for (const workerName of requiredMonacoWorkers) {
    if (!assets.some((asset) => asset.includes(workerName))) {
      failures.push(
        `Packaged desktop app is missing Monaco worker asset: dist/renderer/assets/${workerName}*.js`,
      );
    }
  }
}

async function checkMacIcon(app, failures) {
  if (!app.label.includes('.app/Contents/Resources/app.asar')) return false;

  const appIconPath = 'icon.icns';
  if (!(await app.exists(appIconPath))) {
    failures.push(`Packaged macOS app is missing TeXRA icon: ${appIconPath}`);
    return true;
  }

  const [expectedIcon, actualIcon] = await Promise.all([
    readFile(desktopIconPath),
    app.readBuffer(appIconPath),
  ]);
  if (!expectedIcon.equals(actualIcon)) {
    failures.push(
      `Packaged macOS app icon does not match source icon: ${appIconPath}`,
    );
  }
  return true;
}

async function verifyPackage() {
  const label = 'Desktop package check';
  const packageRoot =
    process.env.TEXRA_DESKTOP_PACKAGE_ROOT ??
    join(desktopRoot, 'dist-packaged');
  const asar = createRequire(import.meta.url)('@electron/asar');

  const app = await findPackagedApp(packageRoot, asar);
  if (!app) {
    return {
      label,
      failures: [`No packaged Electron app found under ${packageRoot}`],
    };
  }

  const failures = [];
  const appPackageJson = await app.readJson('package.json');

  if (appPackageJson.main !== './dist/main/index.js') {
    failures.push(
      `Packaged app main must be ./dist/main/index.js, got ${appPackageJson.main}`,
    );
  }
  await checkRuntimeDependencies(app, appPackageJson, failures);
  await checkExists(app, 'dist/main/index.js', 'main bundle', failures);
  await checkExists(app, 'dist/preload/index.cjs', 'preload bundle', failures);
  await checkExists(app, 'dist/renderer/index.html', 'renderer HTML', failures);
  await checkBundledResources(app, failures);
  await checkMonacoWorkerAssets(app, failures);
  const checkedMacIcon = await checkMacIcon(app, failures);
  await checkNoBundledNativeCliPayload(app, failures);
  await checkNoVscodeRuntimeImport(app, failures);
  await checkDesktopMainDynamicRequireShim(app, failures);
  await checkDesktopStartupBundles(app, failures);

  const assets = await app.listDir('dist/renderer/assets');
  if (!assets.some((asset) => asset.endsWith('.js'))) {
    failures.push('No renderer JavaScript asset found');
  }
  if (!assets.some((asset) => asset.endsWith('.css'))) {
    failures.push('No renderer CSS asset found');
  }

  if (failures.length > 0) return { label, failures };

  const summary = [
    `Desktop package check passed for ${app.label}`,
    '- dist/main/index.js',
    '- dist/preload/index.cjs',
    '- dist/renderer/index.html',
    '- dist/renderer/assets/*.js',
    '- dist/renderer/assets/*.css',
    '- dist/renderer/assets Monaco worker chunks',
    '- resources/agents, resources/tool_use_agents, resources/skills, and resources/plugins',
    '- resources/traceViewer/index.html',
    '- package.json runtime dependencies',
    '- node_modules runtime dependency packages',
    '- no bundled Codex or Claude Code CLI payload',
    '- no VS Code extension host runtime import',
    '- desktop main dynamic require shim',
    '- desktop startup import graph excludes provider SDKs',
  ];
  if (checkedMacIcon) summary.splice(7, 0, '- macOS app icon');

  return { label, summary };
}

// ---------------------------------------------------------------------------
// Stage: smoke-package
// ---------------------------------------------------------------------------

const READINESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 32_000;
let diagnosticOutput = '';

function appendDiagnostic(label, value) {
  const text = String(value).trim();
  if (!text) return;
  diagnosticOutput = appendBoundedLog(
    diagnosticOutput,
    `[${label}] ${text}\n`,
    MAX_DIAGNOSTIC_CHARS,
  );
}

function createRuntimeFailureSignal() {
  let firstError;
  let resolveFirstError;
  const promise = new Promise((resolvePromise) => {
    resolveFirstError = resolvePromise;
  });
  return {
    get error() {
      return firstError;
    },
    promise,
    report(label, value) {
      const message = String(value).trim() || label;
      appendDiagnostic(label, message);
      if (firstError) return;
      firstError = new Error(`${label}: ${message}`);
      resolveFirstError(firstError);
    },
  };
}

function defaultPackagedExecutables() {
  const packagedRoot = join(desktopRoot, 'dist-packaged');
  if (process.platform === 'darwin') {
    const appExecutable = ['TeXRA.app', 'Contents', 'MacOS', 'TeXRA'];
    const localArchDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return [
      join(packagedRoot, 'mac-universal', ...appExecutable),
      join(packagedRoot, localArchDir, ...appExecutable),
    ];
  }
  if (process.platform === 'win32') {
    return [join(packagedRoot, 'win-unpacked', 'TeXRA.exe')];
  }
  if (process.platform === 'linux') {
    return [join(packagedRoot, 'linux-unpacked', 'texra')];
  }
  return [];
}

async function resolvePackagedExecutable(argv) {
  const appFlagIndex = argv.indexOf('--app');
  const appFlagValue = appFlagIndex === -1 ? undefined : argv[appFlagIndex + 1];
  if (appFlagIndex !== -1 && !appFlagValue) {
    throw new Error('Missing value after --app.');
  }

  const candidates = appFlagValue
    ? [resolve(appFlagValue)]
    : defaultPackagedExecutables();
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Try the local architecture fallback on macOS.
    }
  }

  const expectedPaths =
    candidates.length > 0
      ? candidates.map((candidate) => `- ${candidate}`).join('\n')
      : '- pass --app <executable> on this platform';
  throw new Error(
    `Packaged desktop executable was not found.\n${expectedPaths}\n` +
      'Package the desktop app before running the smoke.',
  );
}

async function createIsolation(root, rememberOpenProject) {
  const profile = join(root, 'profile');
  const paths = {
    profile,
    userData: join(profile, 'user-data'),
    workspace: join(root, 'workspace'),
  };
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true })),
  );
  // Seed the same private SQLite record read by desktop startup.
  await rememberOpenProject(paths.userData, paths.workspace);
  return paths;
}

function observeApplication(application, runtimeFailure) {
  const child = application.process();
  child.on('error', (error) => {
    runtimeFailure.report('process error', errorMessage(error));
  });
  child.stdout?.on('data', (chunk) => appendDiagnostic('stdout', chunk));
  child.stderr?.on('data', (chunk) => appendDiagnostic('stderr', chunk));
  application.on('console', (message) => {
    const label = `main ${message.type()}`;
    if (message.type() === 'error') {
      runtimeFailure.report(label, message.text());
    } else {
      appendDiagnostic(label, message.text());
    }
  });

  const observedPages = new WeakSet();
  const observeNewPage = (page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    observePage(page, runtimeFailure);
  };
  const context = application.context();
  context.on('page', observeNewPage);
  for (const page of context.pages()) observeNewPage(page);
}

function observePage(page, runtimeFailure) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      appendDiagnostic(`renderer ${message.type()}`, message.text());
    }
  });
  page.on('pageerror', (error) => {
    runtimeFailure.report('renderer exception', error.message);
  });
  page.on('crash', () => runtimeFailure.report('renderer', 'page crashed'));
}

async function waitForReadiness(application) {
  const isPackaged = await application.evaluate(({ app }) => app.isPackaged);
  if (!isPackaged) {
    throw new Error('Electron main process reported app.isPackaged = false.');
  }

  const page = await application.firstWindow({ timeout: 0 });
  const handle = await page.waitForFunction(
    () => {
      // The renderer mounts into `<main id="app">` (renderer/index.html);
      // there is no `.desktop-shell` element, so keying readiness off one
      // could never resolve.
      const shell = document.querySelector('main#app');
      const mainApp = document.querySelector(
        'progress-app[data-desktop-view="progress"]',
      );
      const shellReady =
        shell instanceof HTMLElement &&
        shell.isConnected &&
        shell.getClientRects().length > 0 &&
        window.getComputedStyle(shell).visibility !== 'hidden';
      const mainAppReady =
        mainApp instanceof HTMLElement &&
        mainApp.isConnected &&
        (mainApp.shadowRoot?.childElementCount ?? 0) > 0;
      const project = document.querySelector(
        '.shell-launcher-surface[data-session]',
      );
      const projectReady =
        project instanceof HTMLElement && Boolean(project.dataset.session);
      const theme = document.body.dataset.vscodeThemeKind;
      const themeReady =
        theme === 'dark' || theme === 'light' || theme === 'high-contrast';
      return shellReady && mainAppReady && projectReady && themeReady
        ? { theme }
        : false;
    },
    undefined,
    { polling: 100, timeout: 0 },
  );
  const readiness = await handle.jsonValue();
  await handle.dispose();
  return readiness;
}

async function closeApplication(application, exitPromise) {
  const child = application.process();
  if (hasExited(child)) return;

  let closeFailure = await Promise.race([
    application.close().then(
      () => null,
      (error) => error,
    ),
    delay(SHUTDOWN_GRACE_MS).then(
      () => new Error('ElectronApplication.close() timed out.'),
    ),
  ]);
  if (!closeFailure) {
    if (hasExited(child)) return;
    const exitObserved = await Promise.race([
      exitPromise.then(() => true),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (exitObserved && hasExited(child)) return;
    closeFailure = new Error(
      'ElectronApplication.close() completed before the process exited.',
    );
  }

  if (hasExited(child)) return;

  appendDiagnostic(
    'teardown',
    `graceful close did not complete: ${errorMessage(closeFailure)}`,
  );
  appendDiagnostic(
    'teardown',
    'forcing the Electron process to stop after graceful close failed',
  );
  await stopChild(child, exitPromise, {
    graceMs: SHUTDOWN_GRACE_MS,
    label: 'Packaged app',
  });
}

async function smokePackagedLaunch(args) {
  const label = 'Desktop package launch smoke';
  const desktopRequire = createRequire(join(desktopRoot, 'package.json'));
  const { _electron: electron } = desktopRequire('@playwright/test');
  const { buildDesktopSmokeEnvironment, rememberOpenProject } =
    await import('./desktop-package-smoke-environment.mjs');

  let executablePath;
  let temporaryRoot;
  let application;
  let exitPromise;
  let readiness;
  let failure;
  let phase = 'resolving packaged executable';

  try {
    executablePath = await resolvePackagedExecutable(args);
    phase = 'creating isolated profile and workspace';
    temporaryRoot = await mkdtemp(join(tmpdir(), 'texra-package-smoke-'));
    const paths = await createIsolation(temporaryRoot, rememberOpenProject);

    phase = 'launching packaged Electron app';
    application = await electron.launch({
      executablePath,
      cwd: paths.workspace,
      env: buildDesktopSmokeEnvironment(process.env, paths),
      timeout: READINESS_TIMEOUT_MS,
    });

    const child = application.process();
    const runtimeFailure = createRuntimeFailureSignal();
    observeApplication(application, runtimeFailure);
    exitPromise = waitForTermination(child);
    phase = 'waiting for packaged desktop readiness';

    const outcome = await Promise.race([
      waitForReadiness(application).then(
        (value) => ({ kind: 'ready', value }),
        (error) => ({ kind: 'failure', error }),
      ),
      exitPromise.then((exit) => ({ kind: 'exit', exit })),
      runtimeFailure.promise.then((error) => ({ kind: 'failure', error })),
      delay(READINESS_TIMEOUT_MS).then(() => ({ kind: 'timeout' })),
    ]);
    if (outcome.kind === 'failure') throw outcome.error;
    if (outcome.kind === 'exit') {
      const description = formatExit(outcome.exit);
      throw new Error(`Packaged app exited before readiness (${description}).`);
    }
    if (outcome.kind === 'timeout') {
      throw new Error(
        `TeXRA readiness was not reached within ${READINESS_TIMEOUT_MS}ms.`,
      );
    }
    readiness = outcome.value;
    if (runtimeFailure.error) throw runtimeFailure.error;
    if (hasExited(child)) {
      throw new Error('Packaged app exited while reporting readiness.');
    }
  } catch (error) {
    failure = { error, phase };
  } finally {
    if (application) {
      try {
        exitPromise ??= waitForTermination(application.process());
        await closeApplication(application, exitPromise);
      } catch (error) {
        if (failure) {
          appendDiagnostic('teardown', errorMessage(error));
        } else {
          failure = { error, phase: 'closing packaged Electron app' };
        }
      }
    }

    if (temporaryRoot) {
      try {
        await rm(temporaryRoot, {
          force: true,
          maxRetries: 3,
          recursive: true,
          retryDelay: 100,
        });
      } catch (error) {
        if (failure) {
          appendDiagnostic('cleanup', errorMessage(error));
        } else {
          failure = { error, phase: 'removing temporary smoke directories' };
        }
      }
    }
  }

  if (failure) {
    const failures = [`while ${failure.phase}: ${errorMessage(failure.error)}`];
    if (executablePath) failures.push(`Executable: ${executablePath}`);
    if (diagnosticOutput.trim()) {
      failures.push(`Diagnostics:\n${diagnosticOutput.trim()}`);
    }
    return { label, failures };
  }

  return {
    label,
    summary: [
      `Desktop package launch smoke passed: packaged app reached TeXRA readiness (${readiness.theme}) at ${executablePath}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage: smoke-webviews
// ---------------------------------------------------------------------------

const nonce = 'texra-webview-smoke';

// The progress webview is the one bundle the sidebar and the editor tab
// load. It renders nothing until the host answers its `subscribe` with an
// events frame carrying the host snapshot, so each progress view carries a
// session fixture: the bridge shim below plays the host, answering every
// subscribe with the fixture's events (listing rows for every run, the
// transcript tier for the aggregates the subscribe named), the way
// `SessionFramer` cuts a frame.
const SESSION_KEY = '/tmp/texra-smoke/project';
const OWNER = '["test-host",4242,"2026-09-04T00:00:00.000Z"]';
const NOW = 1_783_353_600_000;
const RUN = 'a1b2c3d4e5f6';
const CHILD_RUN = 'b1b2c3d4e5f6';

const hostSnapshot = {
  project: {
    key: SESSION_KEY,
    name: 'project',
    initials: 'PR',
    subtitle: SESSION_KEY,
  },
  agentOptions: {
    toolUse: [
      { value: 'orchestrator', label: 'orchestrator' },
      { value: 'research', label: 'research' },
    ],
    workflow: [{ value: 'correct', label: 'correct' }],
  },
  modelOptions: [{ value: 'deepseekT', label: 'DeepSeek V4 Flash' }],
  teamOptions: [],
  workspaceRoots: [],
  fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
  isGitRepo: false,
  recording: null,
  debugMode: false,
  banners: {
    apiKey: { visible: false },
    agentConfig: { visible: false },
    dependency: { visible: false },
    gettingStarted: false,
    login: false,
  },
  onboarding: 'done',
};

/** Seq numbered per aggregate and committed in one session order. */
function sessionLog() {
  const events = [];
  const seqs = new Map();
  let commit = 0;
  const emit = (logicalId, at, body) => {
    const aggregateId = JSON.stringify(['run', logicalId]);
    const seq = (seqs.get(aggregateId) ?? 0) + 1;
    seqs.set(aggregateId, seq);
    commit += 1;
    events.push({ aggregateId, seq, commit, ownerId: OWNER, at, ...body });
  };
  const entry = (runId, at, fields) => {
    emit(runId, at, { type: 'log', level: 'info', ...fields });
  };
  return { events, emit, entry };
}

function startRun(log, { runId, agent, at, parentRunId }) {
  const parentCreation = log.events.find(
    (event) =>
      event.type === 'run.start' &&
      event.aggregateId === JSON.stringify(['run', parentRunId]),
  );
  log.emit(runId, at, {
    type: 'run.start',
    identity: { kind: 'agent', agent },
    category: 'toolUse',
    isRemote: false,
    userFollowUpSupport: 'nativeInteractive',
    approvalPolicy: {
      policy: 'ask',
      bypasses: { bash: false, toolEdit: false, superYolo: false },
    },
    parent: parentRunId
      ? { id: parentRunId, startCommit: parentCreation.commit }
      : null,
  });
  log.emit(runId, at, {
    type: 'run.activate',
    category: 'toolUse',
    isRemote: false,
  });
  log.emit(runId, at, {
    type: 'run.config',
    config: {
      agentCategory: 'toolUse',
      model: 'deepseekT',
      agent,
      inputFiles: ['main.tex'],
    },
  });
  log.emit(runId, at, {
    type: 'flow.step',
    payload: { family: 'toolUse', step: 'turn.begin' },
  });
}

function conversationEvents({ approval = false } = {}) {
  const log = sessionLog();
  startRun(log, {
    runId: RUN,
    agent: 'research',
    at: NOW,
  });
  log.emit(RUN, NOW + 500, {
    type: 'run.description',
    description: 'Check citation coverage and suggest BibTeX entries.',
  });
  log.entry(RUN, NOW, {
    messageType: 'userMessage',
    message: 'hello world',
  });
  log.entry(RUN, NOW + 1000, {
    messageType: 'modelResponse',
    message: 'I will inspect the manuscript and report missing citations.',
  });
  log.emit(RUN, NOW + 1500, {
    type: 'conversation.progress',
    progress: { toolCallCount: 1 },
  });
  if (approval) {
    startRun(log, {
      runId: CHILD_RUN,
      agent: 'reviewer',
      at: NOW + 2000,
      parentRunId: RUN,
    });
    log.emit(RUN, NOW + 3000, {
      type: 'request.opened',
      requestId: 'smoke-tool-edit-approval',
      payload: {
        kind: 'toolEdit',
        data: {
          requestId: 'smoke-tool-edit-approval',
          runId: RUN,
          allowBypass: true,
          path: '/tmp/texra-smoke/main.tex',
          relativePath: 'main.tex',
          sourceTool: 'edit_file',
          addedLines: 1,
          removedLines: 1,
          isLatex: true,
        },
      },
      thread: null,
    });
    log.entry(RUN, NOW + 3000, {
      messageType: 'modelResponse',
      message:
        'I found a one-line correction and need approval before editing main.tex.',
    });
  }
  return log.events;
}

function fileUri(relativePath) {
  return pathToFileURL(join(repoRoot, relativePath)).toString();
}

async function smokeWebviews() {
  const label = 'Electron webview smoke';
  const extensionRoot = join(repoRoot, 'packages', 'extension');
  const outputDir = join(repoRoot, 'artifacts', 'webview-smoke');
  const generatedHtmlDir = join(outputDir, 'html');
  const desktopRequire = createRequire(join(desktopRoot, 'package.json'));

  const progressViewReplacements = {
    bundleUri: fileUri('packages/extension/dist/progressView/bundle.js'),
    styleUri: fileUri('packages/extension/dist/progressView/index.css'),
    sessionKey: SESSION_KEY,
    placement: 'sidebar',
  };

  const commonReplacements = {
    cspSource: 'file:',
    commonStyleUri: fileUri('packages/extension/src/common/styles/common.css'),
    desktopThemeTokensUri: fileUri(
      'packages/desktop/src/renderer/themeTokens.css',
    ),
    nonce,
  };

  const views = [
    {
      name: 'progress',
      tagName: 'progress-app',
      templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
      replacements: progressViewReplacements,
      session: { host: hostSnapshot, events: [], selected: null },
    },
    {
      name: 'progress-populated',
      tagName: 'progress-app',
      templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
      viewport: {
        width: 420,
        height: 600,
      },
      assertions: ['progressComposerLayout'],
      replacements: progressViewReplacements,
      session: {
        host: hostSnapshot,
        events: conversationEvents(),
        selected: RUN,
      },
    },
    {
      name: 'progress-approval',
      tagName: 'progress-app',
      templatePath: join(extensionRoot, 'src', 'progressView', 'index.html'),
      viewport: {
        width: 420,
        height: 700,
      },
      assertions: ['toolEditApprovalLayout'],
      replacements: progressViewReplacements,
      session: {
        host: hostSnapshot,
        events: conversationEvents({ approval: true }),
        selected: RUN,
      },
    },
    {
      name: 'settings',
      tagName: 'settings-app',
      templatePath: join(extensionRoot, 'src', 'settingsView', 'index.html'),
      replacements: {
        bundleUri: fileUri('packages/extension/dist/settingsView/bundle.js'),
      },
    },
  ];

  async function prepareViewHtml(view) {
    const template = await readFile(view.templatePath, 'utf8');
    const html = renderWebviewHtml(template, {
      attributeLabel: 'smoke',
      bridgeScript: renderSessionHarnessBridge({
        nonce,
        sessionKey: SESSION_KEY,
        owner: OWNER,
        session: view.session,
        messagesKey: '__texraSmokeMessages',
      }),
      replacements: { ...commonReplacements, ...view.replacements },
      view,
    });
    const htmlPath = join(generatedHtmlDir, `${view.name}.html`);
    await writeFile(htmlPath, html);
    return {
      htmlPath,
      name: view.name,
      tagName: view.tagName,
      assertions: view.assertions ?? [],
      viewport: view.viewport,
    };
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(generatedHtmlDir, { recursive: true });
  const smokeViews = [];
  for (const view of views) {
    smokeViews.push(await prepareViewHtml(view));
  }

  const configPath = join(outputDir, 'config.json');
  await writeFile(
    configPath,
    `${JSON.stringify({ outputDir, views: smokeViews }, null, 2)}\n`,
  );
  await runElectronWebviewHarness({
    configEnv: 'TEXRA_WEBVIEW_SMOKE_CONFIG',
    configPath,
    cwd: repoRoot,
    electronBinaryPath: desktopRequire('electron'),
    failureLabel: label,
    noSandboxEnv: 'TEXRA_WEBVIEW_SMOKE_NO_SANDBOX',
    runnerPath: join(repoRoot, 'scripts', 'smoke-webviews-electron-runner.cjs'),
  });

  return {
    label,
    summary: [`Electron webview smoke passed. Screenshots: ${outputDir}`],
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const stages = {
  'electron-binary': verifyElectronBinary,
  'build-artifacts': verifyBuildArtifacts,
  package: verifyPackage,
  installers: verifyInstallers,
  'signing-env': verifySigningEnv,
  'smoke-package': smokePackagedLaunch,
  'smoke-webviews': smokeWebviews,
};

const [stageName, ...stageArgs] = process.argv.slice(2);
const stage = Object.hasOwn(stages, stageName ?? '')
  ? stages[stageName]
  : undefined;

if (!stage) {
  console.error(
    `Usage: node scripts/verify-desktop.mjs <${Object.keys(stages).join('|')}>`,
  );
  process.exit(1);
}

const { label, failures = [], summary = [] } = await stage(stageArgs);

if (failures.length > 0) {
  console.error(`${label} failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(summary.join('\n'));
}

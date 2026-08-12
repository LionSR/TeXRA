// Node imports
import { resolve } from 'node:path';

// Local imports - desktop test paths
import {
  desktopSourcePath,
  moduleFileUrl,
  repoPath,
} from './desktopTestPaths.ts';

/**
 * Source modules the desktop suite imports by absolute file URL rather than by
 * alias, so a test observes a module instance of its own (fresh across
 * `vi.resetModules()`, and built after any `vi.mock()` this file installs).
 *
 * Keys are the module's repo alias and each value pins its real module type,
 * so tests assert against the shipped surface instead of a hand-written mirror
 * that can drift.
 */
interface TestSourceModules {
  '@platform/defaults/jsonConfigProvider': typeof import('@platform/defaults/jsonConfigProvider');
  '@platform/defaults/jsonStore': typeof import('@platform/defaults/jsonStore');
  '@platform/defaults/nodeHost': typeof import('@platform/defaults/nodeHost');
  '@desktop/shared/desktopCommandSurface': typeof import('@desktop/shared/desktopCommandSurface');
  '@desktop/shared/desktopDiffMessages': typeof import('@desktop/shared/desktopDiffMessages');
  '@desktop/shared/desktopOnboardingMessages': typeof import('@desktop/shared/desktopOnboardingMessages');
  '@desktop/shared/desktopPdfMessages': typeof import('@desktop/shared/desktopPdfMessages');
  '@desktop/main/desktopAgentExecution': typeof import('@desktop/main/desktopAgentExecution');
  '@desktop/main/desktopCrashReporting': typeof import('@desktop/main/desktopCrashReporting');
  '@desktop/main/desktopDiffHost': typeof import('@desktop/main/desktopDiffHost');
  '@desktop/main/desktopExecutionIpc': typeof import('@desktop/main/desktopExecutionIpc');
  '@desktop/main/desktopFileSelection': typeof import('@desktop/main/desktopFileSelection');
  '@desktop/main/desktopMenuTemplate': typeof import('@desktop/main/desktopMenuTemplate');
  '@desktop/main/desktopHistoryHandlers': typeof import('@desktop/main/desktopHistoryHandlers');
  '@desktop/main/desktopLogIpc': typeof import('@desktop/main/desktopLogIpc');
  '@desktop/main/desktopNavigationPolicy': typeof import('@desktop/main/desktopNavigationPolicy');
  '@desktop/main/desktopOnboardingIpc': typeof import('@desktop/main/desktopOnboardingIpc');
  '@desktop/main/desktopPreviewHost': typeof import('@desktop/main/desktopPreviewHost');
  '@desktop/main/desktopProgressFileActions': typeof import('@desktop/main/desktopProgressFileActions');
  '@desktop/main/desktopProgressIpc': typeof import('@desktop/main/desktopProgressIpc');
  '@desktop/main/desktopPromptController': typeof import('@desktop/main/desktopPromptController');
  '@desktop/main/desktopSettingsIpc': typeof import('@desktop/main/desktopSettingsIpc');
  '@desktop/main/desktopShellIpc': typeof import('@desktop/main/desktopShellIpc');
  '@desktop/main/desktopToolEditApproval': typeof import('@desktop/main/desktopToolEditApproval');
  '@desktop/main/desktopUpdateChecker': typeof import('@desktop/main/desktopUpdateChecker');
  '@desktop/main/desktopViewStateIpc': typeof import('@desktop/main/desktopViewStateIpc');
  '@desktop/main/platform/electronSecrets': typeof import('@desktop/main/platform/electronSecrets');
  '@desktop/main/platform/pathFix': typeof import('@desktop/main/platform/pathFix');
  '@desktop/main/platform/paths': typeof import('@desktop/main/platform/paths');
  '@desktop/main/platform/warningDialog': typeof import('@desktop/main/platform/warningDialog');
  '@desktop/renderer/desktopIconLibrary': typeof import('@desktop/renderer/desktopIconLibrary');
  '@desktop/renderer/promptOverlay': typeof import('@desktop/renderer/promptOverlay');
  '@desktop/renderer/rendererPlatform': typeof import('@desktop/renderer/rendererPlatform');
}

const ALIAS_ROOTS: Record<string, string | undefined> = {
  '@platform': repoPath('src', 'platform'),
  '@desktop': desktopSourcePath(),
};

export async function loadSourceModule<K extends keyof TestSourceModules>(
  specifier: K,
): Promise<TestSourceModules[K]> {
  const [alias, ...segments] = specifier.split('/');
  const root = ALIAS_ROOTS[alias];
  if (root === undefined) {
    throw new Error(`No source root registered for alias "${alias}".`);
  }
  return import(moduleFileUrl(`${resolve(root, ...segments)}.ts`)) as Promise<
    TestSourceModules[K]
  >;
}

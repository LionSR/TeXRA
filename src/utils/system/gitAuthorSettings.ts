import { WorkspaceStateKey } from '@common/state/stateKeys';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import { setWorktreeSupportEnabled } from '@tools/worktreeConfig';
import { setGitAuthorEnv } from './gitAuthorEnv';
import type { StateStore } from '@platform/interfaces/state';

export type GitAuthorSettings = {
  markCommits: boolean;
  authorName: string;
  authorEmail: string;
  worktreeSupport: boolean;
};

export function readGitAuthorSettingsFromState(
  workspaceState: StateStore,
): GitAuthorSettings {
  return {
    markCommits: workspaceState.get<boolean>(
      WorkspaceStateKey.GIT_MARK_COMMITS,
      DEFAULT_GIT_MARK_COMMITS,
    ),
    authorName:
      workspaceState.get<string>(WorkspaceStateKey.GIT_AUTHOR_NAME) ||
      DEFAULT_GIT_AUTHOR_NAME,
    authorEmail:
      workspaceState.get<string>(WorkspaceStateKey.GIT_AUTHOR_EMAIL) ||
      DEFAULT_GIT_AUTHOR_EMAIL,
    worktreeSupport: workspaceState.get<boolean>(
      WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
      false,
    ),
  };
}

export function applyGitAuthorSettings(
  settings: GitAuthorSettings,
): GitAuthorSettings {
  if (!settings.markCommits) {
    setGitAuthorEnv({});
  } else {
    const { authorName, authorEmail } = settings;
    setGitAuthorEnv({
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    });
  }
  setWorktreeSupportEnabled(settings.worktreeSupport);
  return settings;
}

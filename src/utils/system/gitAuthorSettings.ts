import type { StateStore } from '@platform/interfaces';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_MARK_COMMITS,
  DEFAULT_GIT_WORKTREE_SUPPORT,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { setWorktreeSupportEnabled } from '@utils/config/worktreeConfig';
import { setGitAuthorEnv } from './gitAuthorEnv';

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
      DEFAULT_GIT_WORKTREE_SUPPORT,
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

import * as path from 'path';

import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { safeHomedir } from '@utils/system/platformPaths';

import { AbsoluteFS } from './absoluteFS';
import { WorkspaceFS } from './workspaceFS';

const CHANNEL = 'rulesUtils';
logger.initialize(CHANNEL);

const RULES_FILE = '.texrarules';

/**
 * TTL-based cache for loaded rules content.
 * Rules files rarely change during a session, so caching avoids redundant
 * disk I/O on every response cycle in multi-turn conversations.
 */
const RULES_CACHE_TTL_MS = 30_000;
let _rulesCache: { content: string; expiry: number } | null = null;

/** Invalidate the rules cache (e.g. when the user explicitly reloads). */
export function invalidateTexraRulesCache(): void {
  _rulesCache = null;
}

/**
 * Load `.texrarules` from the workspace root or the user's home directory.
 * Returns the trimmed content or an empty string if none found.
 * Results are cached for 30s to avoid redundant disk I/O per response cycle.
 */
export async function loadTexraRules(): Promise<string> {
  const now = Date.now();
  if (_rulesCache && now < _rulesCache.expiry) {
    return _rulesCache.content;
  }
  const content = await loadTexraRulesUncached();
  _rulesCache = { content, expiry: Date.now() + RULES_CACHE_TTL_MS };
  return content;
}

async function loadTexraRulesUncached(): Promise<string> {
  try {
    const workspacePath = WorkspaceFS.getPath();

    if (workspacePath && (await WorkspaceFS.exists(RULES_FILE))) {
      const trimmed = (await WorkspaceFS.read(RULES_FILE)).trim();
      if (trimmed) {
        logger.debug(CHANNEL, `Loaded workspace ${RULES_FILE}`);
        return trimmed;
      }
    }

    const homeDir = safeHomedir();
    if (homeDir) {
      const homeFile = path.join(homeDir, RULES_FILE);
      if (await AbsoluteFS.exists(homeFile)) {
        const trimmed = (await AbsoluteFS.read(homeFile)).trim();
        if (trimmed) {
          logger.debug(CHANNEL, `Loaded home ${RULES_FILE}`);
          return trimmed;
        }
      }
    }
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to load ${RULES_FILE}: ${toErrorMessage(err)}`,
    );
  }
  return '';
}

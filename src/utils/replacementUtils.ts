/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import * as logger from '../logger/logUtils';

// Import vscode workspace configuration
import { getConfig } from '../utils/configUtils';

// Import replacement loader
import {
  ReplacementCategory,
  getEnabledReplacements,
  getCustomReplacements,
  applyReplacements as applyReplacementsFunc,
} from './replacementLoader';

const CHANNEL = 'ReplacementUtils';
logger.initialize(CHANNEL);

// Export types and functions from the loader
export type { ReplacementCategory };
export { getEnabledReplacements, getCustomReplacements };

// We keep a local cache of loaded replacements
let replacementCache: Map<string, ReplacementCategory> | null = null;

/**
 * Set the replacement cache - called by extension.ts after loading definitions
 */
export function setReplacementCache(
  cache: Map<string, ReplacementCategory>,
): void {
  replacementCache = cache;
  logger.info(CHANNEL, `Replacement cache set with ${cache.size} categories`);
}

/**
 * Get a specific replacement category from the cache
 */
export function getReplacementsByCategory(
  categoryName: string,
): ReplacementCategory | undefined {
  return replacementCache?.get(categoryName);
}

/**
 * Get all non-regex replacements combined into a single category.
 */
export function getAllReplacements(): ReplacementCategory {
  const enabledCategories = getEnabledReplacements();
  const customReplacements = getCustomReplacements();

  let allPatterns: { [key: string]: string } = {};

  // Add replacements from enabled categories in the cache
  if (replacementCache) {
    for (const [name, category] of replacementCache.entries()) {
      if (enabledCategories.includes(name) && !category.isRegex) {
        allPatterns = { ...allPatterns, ...category.patterns };
      }
    }
  }

  // Add custom replacements (these take precedence over built-in ones)
  allPatterns = { ...allPatterns, ...customReplacements };

  return {
    name: 'all',
    description: 'Combined non-regex replacements',
    isRegex: false,
    patterns: allPatterns,
  };
}

/**
 * Get all regex replacement categories in order of application.
 */
export function getAllReplacementsRegex(): ReplacementCategory[] {
  const regexCategories: ReplacementCategory[] = [];

  // The order matters for these categories
  const regexOrder = ['inlineMath', 'tikz', 'parentheses'];

  if (replacementCache) {
    for (const name of regexOrder) {
      const category = replacementCache.get(name);
      if (category && category.isRegex) {
        regexCategories.push(category);
      }
    }
  }

  return regexCategories;
}

/**
 * Apply replacements to text - passes through to the loader implementation
 */
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
): string {
  return applyReplacementsFunc(text, replacements);
}

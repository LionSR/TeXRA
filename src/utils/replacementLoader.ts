/**
 * Utilities for loading text replacements from YAML files.
 */

// Standard library imports
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// YAML parser
import * as yaml from 'yaml';

// Local imports - log
import * as logger from '../logger/logUtils';

// Import vscode workspace configuration
import { getConfig } from '../utils/configUtils';
import { getCustomReplacementsDirectory } from '../utils/pathUtils';

const CHANNEL = 'ReplacementLoader';
logger.initialize(CHANNEL);

export interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: string };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}

/**
 * Get replacement definitions from YAML files in resources/replacements directory
 */
export async function loadReplacementDefinitions(
  context: vscode.ExtensionContext,
): Promise<Map<string, ReplacementCategory>> {
  const replacements = new Map<string, ReplacementCategory>();

  try {
    // Check custom directory first (highest priority)
    const customDir = await getCustomReplacementsDirectory();

    // Global storage directory (middle priority)
    const globalStoragePath = path.join(
      context.globalStorageUri.fsPath,
      'replacements',
    );

    // Extension resources directory (lowest priority)
    const resourcesPath = path.join(
      context.extensionPath,
      'resources',
      'replacements',
    );

    // Load replacements from all directories, with custom directory taking precedence
    if (customDir && fs.existsSync(customDir)) {
      await loadReplacementsFromDirectory(customDir, replacements, 'custom');
    }

    if (fs.existsSync(globalStoragePath)) {
      await loadReplacementsFromDirectory(
        globalStoragePath,
        replacements,
        'global storage',
      );
    }

    if (fs.existsSync(resourcesPath)) {
      await loadReplacementsFromDirectory(
        resourcesPath,
        replacements,
        'resources',
      );
    }

    logger.info(
      CHANNEL,
      `Loaded ${replacements.size} replacement categories total`,
    );
  } catch (err) {
    logger.error(CHANNEL, `Error loading replacements: ${err}`);
  }

  return replacements;
}

/**
 * Load replacements from a specific directory
 * @param directory Directory to load from
 * @param replacements Map to add replacements to
 * @param sourceLabel Label for logging (custom, global storage, resources)
 */
async function loadReplacementsFromDirectory(
  directory: string,
  replacements: Map<string, ReplacementCategory>,
  sourceLabel: string,
): Promise<void> {
  try {
    logger.info(
      CHANNEL,
      `Loading replacements from ${sourceLabel} directory: ${directory}`,
    );

    // Read all YAML files in the directory
    const files = fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));

    let loaded = 0;
    for (const file of files) {
      try {
        const filePath = path.join(directory, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const replacement = yaml.parse(content) as ReplacementCategory;

        if (replacement.name) {
          // Only add if not already in the map (respect priority)
          if (!replacements.has(replacement.name)) {
            replacements.set(replacement.name, replacement);
            loaded++;
            logger.info(
              CHANNEL,
              `Loaded replacement category: ${replacement.name} with ${Object.keys(replacement.patterns).length} patterns from ${sourceLabel}`,
            );
          } else {
            logger.info(
              CHANNEL,
              `Skipped replacement category: ${replacement.name} from ${sourceLabel} (already loaded from higher priority source)`,
            );
          }
        } else {
          logger.error(
            CHANNEL,
            `Invalid replacement definition in ${file} - missing name property`,
          );
        }
      } catch (err) {
        logger.error(CHANNEL, `Error loading replacement file ${file}: ${err}`);
      }
    }

    logger.info(
      CHANNEL,
      `Loaded ${loaded} replacement categories from ${sourceLabel} directory`,
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error loading replacements from ${sourceLabel} directory: ${err}`,
    );
  }
}

/**
 * Get enabled replacement categories from VS Code settings
 */
export function getEnabledReplacements(): string[] {
  return getConfig('latex.enabledReplacements', [
    'latex_spacing',
    'equations',
    'sections',
    'characters',
  ]);
}

/**
 * Get custom replacements from VS Code settings
 */
export function getCustomReplacements(): { [key: string]: string } {
  return getConfig('latex.customReplacements', {});
}

/**
 * Apply replacements to text, handling both regex and non-regex patterns.
 */
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
): string {
  // Convert single category to array for unified handling
  const replacementArray = Array.isArray(replacements)
    ? replacements
    : [replacements];

  // Process all replacements in order
  for (const category of replacementArray) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        try {
          text = text.replace(
            new RegExp(pattern, category.flags),
            repl as string,
          );
        } catch (regexErr) {
          logger.error(
            CHANNEL,
            `Error with regex pattern "${pattern}": ${regexErr instanceof Error ? regexErr.message : String(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        // The issue: When a pattern like '\e_' is loaded from YAML, JavaScript's replaceAll
        // interprets '\e' as just 'e', not the literal sequence '\e'.
        // Solution: First check if the pattern contains a backslash and handle it specially
        if (old.includes('\\')) {
          // For patterns with backslashes, we'll use a regex approach for safety
          // Escape any regex special characters first
          const escapedPattern = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          text = text.replace(
            new RegExp(escapedPattern, 'g'),
            newText as string,
          );
        } else {
          // For patterns without backslashes, we can use the simpler replaceAll
          text = text.replaceAll(old, newText as string);
        }
      }
    }
  }
  return text;
}

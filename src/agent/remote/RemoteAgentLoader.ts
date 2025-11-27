import * as vscode from 'vscode';
import yaml from 'yaml';
import {
  AgentSetting,
  AgentPrompt,
  AgentPromptSchema,
  parseAgentSetting,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import * as logger from '@logger/logUtils';
import type { ToolDefinition } from '@model';
import { SupabaseClient } from '@/auth/SupabaseClient';
import { SUPABASE_CONFIG } from '@/auth/config';
import { RemoteAgentRegistry } from './RemoteAgentRegistry';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

export interface RemoteAgentMetadata {
  id: string;
  name: string;
  description: string;
  tags: string[];
  visibility: 'public' | 'researcher' | 'whitelist';
  agentType?: string;
}

export interface RemoteAgentConfig {
  name: string;
  settings: AgentSetting;
  prompts: AgentPrompt;
  metadata: RemoteAgentMetadata;
}

/**
 * Loader for remote agents stored in Supabase.
 * Fetches agent configurations via Edge Function with authentication.
 */
export class RemoteAgentLoader {
  /**
   * Load a remote agent configuration by name.
   * Supports _multiple variant: if agentName ends with _multiple, tries to load
   * the _multiple variant first, then falls back to base agent if not found.
   */
  static async loadRemoteAgent(
    agentName: string,
    options?: { preferMultiple?: boolean },
  ): Promise<RemoteAgentConfig> {
    // Check if user is authenticated
    const isAuth = await SupabaseClient.isAuthenticated();
    if (!isAuth) {
      throw new Error(
        'Remote agents require authentication. Sign in using the "TeXRA: Sign In" command.',
      );
    }

    // Check if remote agents are enabled
    const config = vscode.workspace.getConfiguration('texra.remoteAgents');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled) {
      throw new Error(
        'Remote agents are disabled. Enable them in settings: texra.remoteAgents.enabled',
      );
    }

    const preferMultiple = options?.preferMultiple ?? false;

    // Build candidate names: if preferMultiple, try _multiple variant first
    const candidateNames: string[] = [];
    if (preferMultiple) {
      const multipleName = agentName.endsWith('_multiple')
        ? agentName
        : `${agentName}_multiple`;
      candidateNames.push(multipleName);
    }
    candidateNames.push(agentName);

    logger.info(
      CHANNEL,
      `Loading remote agent: ${agentName} (preferMultiple: ${preferMultiple}, candidates: ${candidateNames.join(', ')})`,
    );

    // Try each candidate name in order
    let lastError: Error | null = null;
    for (const candidateName of candidateNames) {
      try {
        // Get auth token
        const token = await SupabaseClient.getAccessToken();
        if (!token) {
          throw new Error(
            'Authentication token unavailable. Try signing in again.',
          );
        }

        // Fetch agent config from edge function
        const response = await fetch(SUPABASE_CONFIG.edgeFunctionUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agentName: candidateName }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Session expired. Sign in again to continue.');
          } else if (response.status === 404) {
            // If not found and we have more candidates to try, continue to next
            if (candidateName !== candidateNames[candidateNames.length - 1]) {
              logger.debug(
                CHANNEL,
                `Agent variant "${candidateName}" not found, trying next candidate`,
              );
              lastError = new Error(
                `Agent variant "${candidateName}" not found`,
              );
              continue;
            }
            throw new Error(
              `Agent "${agentName}" not found or access denied. Verify the agent name and your permissions.`,
            );
          } else if (response.status === 403) {
            throw new Error(
              `Access denied to agent "${agentName}". Upgrade your account for access.`,
            );
          } else {
            let errorText = 'Unknown error';
            try {
              errorText = await response.text();
            } catch (error) {
              logger.warn(CHANNEL, 'Failed to read error response body');
            }
            throw new Error(
              `Failed to load agent: ${response.statusText} - ${errorText}`,
            );
          }
        }

        const responseData = await response.json();
        const { config: yamlContent, name, description } = responseData;

        if (!yamlContent) {
          throw new Error(
            'Server returned empty configuration. Contact support.',
          );
        }

        // Parse YAML configuration
        logger.debug(
          CHANNEL,
          `Parsing YAML for remote agent: ${candidateName}`,
        );
        const parsed = yaml.parse(yamlContent);
        const validated = AgentDefinitionSchema.parse(parsed);

        // Extract settings and prompts
        const settings: Partial<AgentSetting> = validated.settings || {};
        const prompts: Partial<AgentPrompt> = validated.prompts || {};

        // Resolve tool names to definitions
        if (Array.isArray(settings.tools)) {
          const { DEFAULT_TOOL_REGISTRY } = await import('@tools/registry');
          settings.tools = (settings.tools as any[]).map((item) => {
            if (typeof item === 'string') {
              const tool = DEFAULT_TOOL_REGISTRY[item];
              if (!tool) {
                logger.warn(CHANNEL, `Tool "${item}" not found in registry`);
                return { name: item } as ToolDefinition;
              }
              return tool.definition;
            }
            if (!DEFAULT_TOOL_REGISTRY[item.name]) {
              logger.warn(CHANNEL, `Tool "${item.name}" not found in registry`);
            }
            return item as ToolDefinition;
          });
        }

        const validatedSettings = parseAgentSetting(settings);
        const validatedPrompts = AgentPromptSchema.parse(prompts);

        // Fetch metadata for the original agent name (not the candidate variant)
        const metadata = await this.getAgentMetadata(agentName);

        logger.info(
          CHANNEL,
          `Successfully loaded remote agent: ${agentName} (resolved to ${candidateName})`,
        );

        return {
          name: validated.name || agentName,
          settings: validatedSettings,
          prompts: validatedPrompts,
          metadata: metadata || {
            id: '',
            name: agentName,
            description: description || '',
            tags: [],
            visibility: 'researcher',
          },
        };
      } catch (error) {
        // If this is the last candidate, throw the error
        if (candidateName === candidateNames[candidateNames.length - 1]) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error(
            CHANNEL,
            `Failed to load remote agent "${agentName}": ${errorMessage}`,
          );
          throw error;
        }
        // Otherwise, store the error and continue to next candidate
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.debug(
          CHANNEL,
          `Failed to load candidate "${candidateName}", trying next: ${lastError.message}`,
        );
      }
    }

    // If we get here, all candidates failed
    throw (
      lastError ||
      new Error(`Failed to load remote agent "${agentName}" after all attempts`)
    );
  }

  /**
   * List all available remote agents for the current user.
   */
  static async listRemoteAgents(): Promise<RemoteAgentMetadata[]> {
    const isAuth = await SupabaseClient.isAuthenticated();
    if (!isAuth) {
      return [];
    }

    try {
      const tokens = await SupabaseClient.getSessionTokens();
      if (!tokens) {
        return [];
      }

      const supabase = SupabaseClient.getClient();

      // Set auth session for RLS - requires both tokens
      await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      // RLS will automatically filter based on user's permissions
      const { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, tags, visibility, agent_type')
        .order('name');

      if (error) {
        logger.error(CHANNEL, `Failed to list remote agents: ${error.message}`);
        return [];
      }

      // Map snake_case DB columns to camelCase interface
      return (data || []).map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        tags: row.tags,
        visibility: row.visibility,
        agentType: row.agent_type,
      })) as RemoteAgentMetadata[];
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(CHANNEL, `Error listing remote agents: ${errorMessage}`);
      return [];
    }
  }

  /**
   * Get metadata for a specific remote agent.
   */
  static async getAgentMetadata(
    agentName: string,
  ): Promise<RemoteAgentMetadata | null> {
    try {
      const tokens = await SupabaseClient.getSessionTokens();
      if (!tokens) {
        return null;
      }

      const supabase = SupabaseClient.getClient();

      // Set auth session for RLS - requires both tokens
      await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      const { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, tags, visibility')
        .eq('name', agentName)
        .single();

      if (error || !data) {
        logger.warn(
          CHANNEL,
          `No metadata found for remote agent: ${agentName}`,
        );
        return null;
      }

      return data as RemoteAgentMetadata;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        CHANNEL,
        `Error fetching metadata for ${agentName}: ${errorMessage}`,
      );
      return null;
    }
  }
}

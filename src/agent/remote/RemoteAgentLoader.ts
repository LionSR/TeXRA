import * as vscode from 'vscode';
import yaml from 'yaml';
import { SupabaseClient } from '@/auth/SupabaseClient';
import {
  AgentSetting,
  AgentPrompt,
  AgentPromptSchema,
  parseAgentSetting,
} from '@agent/core/AgentDataclass';
import { AgentDefinitionSchema } from '@agent/core/AgentDataclass';
import { DEFAULT_TOOL_REGISTRY } from '@tools/registry';
import type { ToolDefinition } from '@model';
import * as logger from '@logger/logUtils';

const CHANNEL = 'RemoteAgentLoader';
logger.initialize(CHANNEL);

export interface RemoteAgentMetadata {
  id: string;
  name: string;
  description: string;
  tags: string[];
  visibility: 'public' | 'premium' | 'whitelist';
}

export interface RemoteAgentConfig {
  name: string;
  settings: AgentSetting;
  prompts: AgentPrompt;
  metadata: RemoteAgentMetadata;
}

/**
 * Loader for remote agents stored in Supabase.
 * Fetches agent configurations from Supabase Storage via Edge Function,
 * with proper authentication and permission checking.
 */
export class RemoteAgentLoader {
  /**
   * Load a remote agent configuration by name.
   * The agent YAML is fetched from Supabase Storage and parsed in memory only.
   */
  static async loadRemoteAgent(agentName: string): Promise<RemoteAgentConfig> {
    // Check if user is authenticated
    const isAuth = await SupabaseClient.isAuthenticated();
    if (!isAuth) {
      throw new Error(
        'Authentication required to use remote agents. Please sign in using the "TeXRA: Sign In" command.',
      );
    }

    // Check if remote agents are enabled
    const config = vscode.workspace.getConfiguration('texra.remoteAgents');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled) {
      throw new Error(
        'Remote agents are disabled. Enable in settings: texra.remoteAgents.enabled',
      );
    }

    // Get edge function URL from config
    const edgeFunctionUrl = config.get<string>('edgeFunctionUrl');
    if (!edgeFunctionUrl) {
      throw new Error(
        'Remote agent edge function URL not configured. Set texra.remoteAgents.edgeFunctionUrl in settings.',
      );
    }

    logger.info(CHANNEL, `Loading remote agent: ${agentName}`);

    try {
      // Get auth token
      const token = await SupabaseClient.getAccessToken();
      if (!token) {
        throw new Error('Failed to get authentication token');
      }

      // Fetch agent config from edge function
      const response = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agentName }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Session expired. Please sign in again.');
        } else if (response.status === 404) {
          throw new Error(
            `Remote agent "${agentName}" not found or you don't have access to it.`,
          );
        } else if (response.status === 403) {
          throw new Error(
            `Access denied to remote agent "${agentName}". You may need to upgrade your account.`,
          );
        } else {
          const errorText = await response.text();
          throw new Error(
            `Failed to load remote agent: ${response.statusText} - ${errorText}`,
          );
        }
      }

      const responseData = await response.json();
      const { config: yamlContent, name, description } = responseData;

      if (!yamlContent) {
        throw new Error('No configuration returned from server');
      }

      // Parse YAML (in memory only, never written to disk)
      logger.debug(CHANNEL, `Parsing YAML for remote agent: ${agentName}`);
      const parsed = yaml.parse(yamlContent);
      const validated = AgentDefinitionSchema.parse(parsed);

      // Extract settings and prompts
      let settings: Partial<AgentSetting> = validated.settings || {};
      let prompts: Partial<AgentPrompt> = validated.prompts || {};

      // TODO: Handle inheritance for remote agents if needed
      // For now, remote agents should be self-contained

      // Resolve tool names to definitions
      if (Array.isArray(settings.tools)) {
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

      // Validate and parse
      const validatedSettings = parseAgentSetting(settings);
      const validatedPrompts = AgentPromptSchema.parse(prompts);

      // Fetch metadata from database
      const metadata = await this.getAgentMetadata(agentName);

      logger.info(CHANNEL, `Successfully loaded remote agent: ${agentName}`);

      return {
        name: validated.name || agentName,
        settings: validatedSettings,
        prompts: validatedPrompts,
        metadata: metadata || {
          id: '',
          name: agentName,
          description: description || '',
          tags: [],
          visibility: 'premium',
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        CHANNEL,
        `Failed to load remote agent "${agentName}": ${errorMessage}`,
      );
      throw error;
    }
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
      const token = await SupabaseClient.getAccessToken();
      if (!token) {
        return [];
      }

      const supabase = SupabaseClient.getClient();

      // RLS will automatically filter based on user's permissions
      const { data, error } = await supabase
        .from('remote_agents')
        .select('id, name, description, tags, visibility')
        .order('name');

      if (error) {
        logger.error(CHANNEL, `Failed to list remote agents: ${error.message}`);
        return [];
      }

      return (data || []) as RemoteAgentMetadata[];
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
      const token = await SupabaseClient.getAccessToken();
      if (!token) {
        return null;
      }

      const supabase = SupabaseClient.getClient();

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

  /**
   * Check if a given agent name is a remote agent reference.
   * Remote agents are prefixed with "remote://"
   */
  static isRemoteAgent(agentName: string): boolean {
    return agentName.startsWith('remote://');
  }

  /**
   * Extract the actual agent name from a remote agent reference.
   * e.g., "remote://advanced-researcher" -> "advanced-researcher"
   */
  static extractRemoteAgentName(agentRef: string): string {
    if (!this.isRemoteAgent(agentRef)) {
      return agentRef;
    }
    return agentRef.replace(/^remote:\/\//, '');
  }
}

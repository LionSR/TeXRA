import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';

import { log, initializeLogging } from './utils/logUtils';

const CHANNEL_NAME = 'Coauthor Agent Manager';
initializeLogging(CHANNEL_NAME);

export interface FieldMetadata {
	value: string;
	status: 'inherited' | 'overridden' | 'new';
	sourceAgent?: string;
	readOnly?: boolean;
}

export interface AgentSettings {
	document_tag: FieldMetadata;
	end_tag: FieldMetadata;
	output_type: FieldMetadata;
	prefills: FieldMetadata[];
}

export interface AgentPrompts {
	system_prompt: FieldMetadata;
	user_prefix: FieldMetadata;
	user_request: FieldMetadata;
	user_reflect?: FieldMetadata;
}

export interface Agent {
	id: string;
	name: string;
	extends?: string;
	settings: AgentSettings;
	prompts: AgentPrompts;
	isDefault?: boolean;
}

export class AgentManager {
	private agents: Map<string, Agent> = new Map();
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.loadDefaultAgents();
		this.loadUserAgents();
	}

	private async loadDefaultAgents() {
		try {
			const agentsPath = path.join(this.context.extensionPath, 'agents');
			log(CHANNEL_NAME, 'Load-Default', `Loading agents from: ${agentsPath}`);

			const files = await fs.promises.readdir(agentsPath);
			log(CHANNEL_NAME, 'Load-Default', `Found agent files: ${files.join(', ')}`);

			for (const file of files) {
				if (file.endsWith('.xml')) {
					const filePath = path.join(agentsPath, file);
					log(CHANNEL_NAME, 'Load-Default', `Loading agent from: ${filePath}`);
					
					try {
						const content = await fs.promises.readFile(filePath, 'utf-8');
						log(CHANNEL_NAME, 'Load-Default', `File content length: ${content.length}`);
						
						const agent = await this.parseAgentXml(content);
						if (agent) {
							agent.isDefault = true;
							this.agents.set(agent.id, agent);
							log(CHANNEL_NAME, 'Load-Default', `Successfully loaded agent: ${agent.id}`);
						} else {
							log(CHANNEL_NAME, 'Load-Default', `Failed to parse agent from ${file}`, true);
						}
					} catch (fileError) {
						log(CHANNEL_NAME, 'Load-Default', `Error reading file ${file}: ${fileError}`, true);
					}
				}
			}

			log(CHANNEL_NAME, 'Load-Default', `Total agents loaded: ${this.agents.size}`);
			log(CHANNEL_NAME, 'Load-Default', `Loaded agents: ${Array.from(this.agents.keys()).join(', ')}`);

		} catch (error) {
			log(CHANNEL_NAME, 'Load-Default', `Error loading default agents: ${error}`, true);
		}
	}

	private async loadUserAgents() {
		const userAgents = this.context.globalState.get<Agent[]>('userAgents', []);
		for (const agent of userAgents) {
			this.agents.set(agent.id, agent);
		}
	}

	private async parseAgentXml(content: string): Promise<Agent | null> {
		try {
			log(CHANNEL_NAME, 'Parse-XML', 'Starting XML parsing');
			const parser = new xml2js.Parser();
			const result = await parser.parseStringPromise(content);
			
			log(CHANNEL_NAME, 'Parse-XML', 'XML parsed successfully');
			log(CHANNEL_NAME, 'Parse-XML', `Agent data: ${JSON.stringify(result.agent.$)}`);

			// Extract base agent info
			const agentData = result.agent;
			const agent: Agent = {
				id: agentData.$.name,
				name: agentData.$.name,
				extends: agentData.$.inherits,
				settings: this.parseSettings(agentData.settings[0]),
				prompts: this.parsePrompts(agentData.prompts[0])
			};

			log(CHANNEL_NAME, 'Parse-XML', `Agent parsed: ${agent.id}, extends: ${agent.extends || 'none'}`);
			return agent;
		} catch (error) {
			log(CHANNEL_NAME, 'Parse-XML', `Error parsing agent XML: ${error}`, true);
			return null;
		}
	}

	private parseSettings(settingsData: any): AgentSettings {
		return {
			document_tag: {
				value: settingsData.document_tag?.[0] || '',
				status: 'new'
			},
			end_tag: {
				value: settingsData.end_tag?.[0] || '',
				status: 'new'
			},
			output_type: {
				value: settingsData.output_type?.[0] || 'tex',
				status: 'new'
			},
			prefills: (settingsData.prefills?.[0]?.prefill || []).map((p: string) => ({
				value: p,
				status: 'new'
			}))
		};
	}

	private parsePrompts(promptsData: any): AgentPrompts {
		return {
			system_prompt: {
				value: promptsData.system_prompt?.[0] || '',
				status: 'new'
			},
			user_prefix: {
				value: promptsData.user_prefix?.[0] || '',
				status: 'new'
			},
			user_request: {
				value: promptsData.user_request?.[0] || '',
				status: 'new'
			},
			user_reflect: promptsData.user_reflect ? {
				value: promptsData.user_reflect[0],
				status: 'new'
			} : undefined
		};
	}

	public async resolveInheritance(agent: Agent): Promise<Agent> {
		log(CHANNEL_NAME, 'Inheritance', `Resolving inheritance for agent: ${agent.id}`);
		
		if (!agent.extends) {
			log(CHANNEL_NAME, 'Inheritance', `Agent ${agent.id} has no base agent`);
			return agent;
		}
	
		const baseAgent = this.agents.get(agent.extends);
		if (!baseAgent) {
			log(CHANNEL_NAME, 'Inheritance', `Base agent ${agent.extends} not found for ${agent.id}`, true);
			return agent;
		}
	
		log(CHANNEL_NAME, 'Inheritance', `Resolving base agent ${baseAgent.id} for ${agent.id}`);
		const resolvedBase = await this.resolveInheritance(baseAgent);
		log(CHANNEL_NAME, 'Inheritance', `Merging ${agent.id} with base ${resolvedBase.id}`);
		
		return this.mergeAgents(resolvedBase, agent);
	}

	private mergeAgents(base: Agent, derived: Agent): Agent {
		const merged: Agent = {
			...derived,
			settings: this.mergeSettings(base.settings, derived.settings),
			prompts: this.mergePrompts(base.prompts, derived.prompts)
		};

		return merged;
	}

	private mergeSettings(base: AgentSettings, derived: AgentSettings): AgentSettings {
		return {
			document_tag: this.mergeField(base.document_tag, derived.document_tag),
			end_tag: this.mergeField(base.end_tag, derived.end_tag),
			output_type: this.mergeField(base.output_type, derived.output_type),
			prefills: this.mergePrefills(base.prefills, derived.prefills)
		};
	}

	private mergePrompts(base: AgentPrompts, derived: AgentPrompts): AgentPrompts {
		return {
			system_prompt: this.mergeField(base.system_prompt, derived.system_prompt),
			user_prefix: this.mergeField(base.user_prefix, derived.user_prefix),
			user_request: this.mergeField(base.user_request, derived.user_request),
			user_reflect: derived.user_reflect ? 
				this.mergeField(base.user_reflect, derived.user_reflect) :
				base.user_reflect
		};
	}

	private mergeField(base: FieldMetadata | undefined, derived: FieldMetadata): FieldMetadata {
		// log(CHANNEL_NAME, 'Merge-Field', `Merging field - base: ${base?.value}, derived: ${derived?.value}`);
		
		if (!base) {
			log(CHANNEL_NAME, 'Merge-Field', 'Base field is undefined, returning derived as new', true);
			return {
				...derived,
				status: 'new'
			};
		}

		if (derived?.value) {
			return {
				...derived,
				status: 'overridden',
				sourceAgent: base.sourceAgent
			};
		}
		return {
			...base,
			status: 'inherited',
			readOnly: true
		};
	}

	private mergePrefills(base: FieldMetadata[], derived: FieldMetadata[]): FieldMetadata[] {
		if (derived.length > 0) {
			return derived.map(d => ({
				...d,
				status: 'overridden',
				sourceAgent: base[0]?.sourceAgent
			}));
		}
		return base.map(b => ({
			...b,
			status: 'inherited',
			readOnly: true
		}));
	}

	public async saveAgent(agent: Agent): Promise<void> {
		if (agent.isDefault) {
			throw new Error('Cannot modify default agents');
		}

		this.agents.set(agent.id, agent);
		await this.saveUserAgents();
	}

	private async saveUserAgents(): Promise<void> {
		const userAgents = Array.from(this.agents.values())
			.filter(a => !a.isDefault);
		await this.context.globalState.update('userAgents', userAgents);
	}

	public async exportToXml(agent: Agent): Promise<string> {
		const builder = new xml2js.Builder();
		const xmlObj = {
			agent: {
				$: {
					name: agent.name,
					inherits: agent.extends
				},
				settings: [this.settingsToXml(agent.settings)],
				prompts: [this.promptsToXml(agent.prompts)]
			}
		};
		return builder.buildObject(xmlObj);
	}

	private settingsToXml(settings: AgentSettings): any {
		return {
			document_tag: [settings.document_tag.value],
			end_tag: [settings.end_tag.value],
			output_type: [settings.output_type.value],
			prefills: [{
				prefill: settings.prefills.map(p => p.value)
			}]
		};
	}

	private promptsToXml(prompts: AgentPrompts): any {
		const result: any = {
			system_prompt: [prompts.system_prompt.value],
			user_prefix: [prompts.user_prefix.value],
			user_request: [prompts.user_request.value]
		};
		if (prompts.user_reflect) {
			result.user_reflect = [prompts.user_reflect.value];
		}
		return result;
	}

	public getAgents(): Map<string, Agent> {
		return this.agents;
	}
}
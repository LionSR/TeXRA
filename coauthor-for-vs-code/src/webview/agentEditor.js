// coauthor-for-vs-code/src/webview/agentEditor.js

// State management
let state = {
	selectedAgent: null,
	agents: [],
	isDarkTheme: false
};

// Initialize state from VS Code storage
const previousState = vscode.getState();
if (previousState) {
	state = previousState;
	vscode.postMessage({
		command: 'showInformationMessage',
		text: 'Restored previous state'
	});
}

// Theme handling
function updateTheme(theme) {
	state.isDarkTheme = theme === 'dark';
	document.body.className = state.isDarkTheme ? 'dark-theme' : 'light-theme';
	vscode.setState(state);
}

// Agent list management
function renderAgentList() {
	vscode.postMessage({
		command: 'showInformationMessage',
		text: `Rendering agent list with ${state.agents.length} agents`
	});

	const agentList = document.getElementById('agentList');
	if (!agentList) {
		vscode.postMessage({
			command: 'showError',
			message: 'Agent list element not found'
		});
		return;
	}
	agentList.innerHTML = '';

	if (state.agents.length === 0) {
		const emptyMessage = document.createElement('div');
		emptyMessage.className = 'empty-message';
		emptyMessage.textContent = 'No agents available';
		agentList.appendChild(emptyMessage);
		vscode.postMessage({
			command: 'showInformationMessage',
			text: 'No agents to display'
		});
		return;
	}

	state.agents.forEach(agent => {
		vscode.postMessage({
			command: 'showInformationMessage',
			text: `Creating agent item: ${agent.name}`
		});

		const agentItem = document.createElement('div');
		agentItem.className = 'agent-item';
		if (agent.extends) {
			agentItem.classList.add('inherited-agent');
		}
		if (agent.isDefault) {
			agentItem.classList.add('default-agent');
		}
		if (agent.id === state.selectedAgent) {
			agentItem.classList.add('selected');
		}

		const agentName = document.createElement('span');
		agentName.textContent = agent.name;
		agentItem.appendChild(agentName);

		if (agent.extends) {
			const inheritInfo = document.createElement('span');
			inheritInfo.className = 'inherit-info';
			inheritInfo.textContent = `extends ${agent.extends}`;
			agentItem.appendChild(inheritInfo);
		}

		agentItem.addEventListener('click', () => selectAgent(agent.id));
		agentList.appendChild(agentItem);

		vscode.postMessage({
			command: 'showInformationMessage',
			text: `Added agent to list: ${agent.name}`
		});
	});
}

// Agent selection
function selectAgent(agentId) {
	const previousAgent = state.selectedAgent;
	state.selectedAgent = agentId;
	
	const agentItems = document.querySelectorAll('.agent-item');
	agentItems.forEach(item => {
		item.style.transition = 'background-color 0.2s';
		item.classList.remove('selected');
	});

	const selectedItem = document.querySelector(`[data-agent-id="${agentId}"]`);
	if (selectedItem) {
		selectedItem.classList.add('selected');
	}

	vscode.setState(state);
	renderAgentEditor(agentId);
}

// Editor rendering
function renderAgentEditor(agentId) {
	const agent = state.agents.find(a => a.id === agentId);
	if (!agent) return;

	const editor = document.getElementById('agentForm');
	editor.innerHTML = `
        <div class="editor-header">
            <div>
                <h2>${agent.name}</h2>
                ${agent.extends ? `<div class="inherit-info">extends ${agent.extends}</div>` : ''}
            </div>
            ${agent.isDefault ? '<span class="default-badge">Default</span>' : ''}
        </div>
        
        <div class="editor-sections">
            <section class="settings-section">
                <h3>Settings</h3>
                ${renderSettingsFields(agent.settings)}
            </section>

            <section class="prompts-section">
                <h3>Prompts</h3>
                ${renderPromptsFields(agent.prompts)}
            </section>
        </div>

        <div class="editor-actions">
            ${!agent.isDefault ? `
                <button id="saveButton" class="primary-button">
                    <i class="codicon codicon-save"></i> Save
                </button>
            ` : ''}
            <button id="exportButton" class="secondary-button">
                <i class="codicon codicon-export"></i> Export
            </button>
        </div>
    `;

	setupEditorEventListeners(agent);
}

function renderSettingsFields(settings) {
	return `
        <div class="field-group">
            <label>Document Tag</label>
            <div class="field-container ${settings.document_tag.status}">
                <input type="text" 
                       name="document_tag"
                       value="${escapeHtml(settings.document_tag.value)}"
                       ${settings.document_tag.readOnly ? 'readonly' : ''}
                >
                ${renderInheritanceInfo(settings.document_tag)}
            </div>
        </div>

        <div class="field-group">
            <label>End Tag</label>
            <div class="field-container ${settings.end_tag.status}">
                <input type="text" 
                       name="end_tag"
                       value="${escapeHtml(settings.end_tag.value)}"
                       ${settings.end_tag.readOnly ? 'readonly' : ''}
                >
                ${renderInheritanceInfo(settings.end_tag)}
            </div>
        </div>

        <div class="field-group">
            <label>Output Type</label>
            <div class="field-container ${settings.output_type.status}">
                <select name="output_type" 
                        ${settings.output_type.readOnly ? 'disabled' : ''}>
                    <option value="tex" ${settings.output_type.value === 'tex' ? 'selected' : ''}>TeX</option>
                    <option value="md" ${settings.output_type.value === 'md' ? 'selected' : ''}>Markdown</option>
                </select>
                ${renderInheritanceInfo(settings.output_type)}
            </div>
        </div>

        <div class="field-group">
            <label>Prefills</label>
            <div class="prefills-container">
                ${settings.prefills.map((prefill, index) => `
                    <div class="field-container ${prefill.status}">
                        <input type="text" 
                               name="prefills[${index}]"
                               value="${escapeHtml(prefill.value)}"
                               ${prefill.readOnly ? 'readonly' : ''}
                        >
                        ${renderInheritanceInfo(prefill)}
                        ${!prefill.readOnly ? `
                            <button class="remove-prefill" data-index="${index}">
                                <i class="codicon codicon-close"></i>
                            </button>
                        ` : ''}
                    </div>
                `).join('')}
                ${!settings.prefills[0]?.readOnly ? `
                    <button id="addPrefill" class="add-button">
                        <i class="codicon codicon-add"></i> Add Prefill
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

function renderPromptsFields(prompts) {
	return `
        <div class="field-group">
            <label>System Prompt</label>
            <div class="field-container ${prompts.system_prompt.status}">
                <textarea name="system_prompt"
                          rows="10"
                          ${prompts.system_prompt.readOnly ? 'readonly' : ''}
                >${escapeHtml(prompts.system_prompt.value)}</textarea>
                ${renderInheritanceInfo(prompts.system_prompt)}
            </div>
        </div>

        <div class="field-group">
            <label>User Prefix</label>
            <div class="field-container ${prompts.user_prefix.status}">
                <textarea name="user_prefix"
                          rows="8"
                          ${prompts.user_prefix.readOnly ? 'readonly' : ''}
                >${escapeHtml(prompts.user_prefix.value)}</textarea>
                ${renderInheritanceInfo(prompts.user_prefix)}
            </div>
        </div>

        <div class="field-group">
            <label>User Request</label>
            <div class="field-container ${prompts.user_request.status}">
                <textarea name="user_request"
                          rows="8"
                          ${prompts.user_request.readOnly ? 'readonly' : ''}
                >${escapeHtml(prompts.user_request.value)}</textarea>
                ${renderInheritanceInfo(prompts.user_request)}
            </div>
        </div>

        ${prompts.user_reflect ? `
            <div class="field-group">
                <label>User Reflect</label>
                <div class="field-container ${prompts.user_reflect.status}">
                    <textarea name="user_reflect"
                              rows="8"
                              ${prompts.user_reflect.readOnly ? 'readonly' : ''}
                    >${escapeHtml(prompts.user_reflect.value)}</textarea>
                    ${renderInheritanceInfo(prompts.user_reflect)}
                </div>
            </div>
        ` : ''}
    `;
}

function renderInheritanceInfo(field) {
	if (field.status === 'inherited' && field.sourceAgent) {
		return `
            <div class="inheritance-info">
                <i class="codicon codicon-arrow-up"></i>
                Inherited from ${escapeHtml(field.sourceAgent)}
            </div>
        `;
	}
	return '';
}

function setupEditorEventListeners(agent) {
	if (!agent.isDefault) {
		const saveButton = document.getElementById('saveButton');
		if (saveButton) {
			saveButton.addEventListener('click', () => saveAgent(agent));
		}
	}

	const exportButton = document.getElementById('exportButton');
	if (exportButton) {
		exportButton.addEventListener('click', () => exportAgent(agent));
	}

	const addPrefillButton = document.getElementById('addPrefill');
	if (addPrefillButton) {
		addPrefillButton.addEventListener('click', () => addPrefill(agent));
	}

	document.querySelectorAll('.remove-prefill').forEach(button => {
		button.addEventListener('click', (e) => {
			const index = parseInt(e.currentTarget.dataset.index);
			removePrefill(agent, index);
		});
	});
}

function saveAgent(agent) {
	const updatedAgent = collectFormData(agent);
	if (validateAgent(updatedAgent)) {
		vscode.postMessage({
			command: 'saveAgent',
			agent: updatedAgent
		});
	}
}

function exportAgent(agent) {
	vscode.postMessage({
		command: 'exportAgent',
		agent: agent.id
	});
}

function collectFormData(agent) {
	const form = document.getElementById('agentForm');
	const formData = new FormData(form);

	// Deep clone the agent to avoid modifying the original
	const updatedAgent = JSON.parse(JSON.stringify(agent));

	// Update settings
	updatedAgent.settings.document_tag.value = formData.get('document_tag');
	updatedAgent.settings.end_tag.value = formData.get('end_tag');
	updatedAgent.settings.output_type.value = formData.get('output_type');

	// Update prefills
	updatedAgent.settings.prefills = Array.from(form.querySelectorAll('input[name^="prefills"]'))
		.map(input => ({
			value: input.value,
			status: 'new'
		}));

	// Update prompts
	updatedAgent.prompts.system_prompt.value = formData.get('system_prompt');
	updatedAgent.prompts.user_prefix.value = formData.get('user_prefix');
	updatedAgent.prompts.user_request.value = formData.get('user_request');
	if (updatedAgent.prompts.user_reflect) {
		updatedAgent.prompts.user_reflect.value = formData.get('user_reflect');
	}

	return updatedAgent;
}

function validateAgent(agent) {
	const requiredFields = [
		{ path: 'settings.document_tag.value', label: 'Document Tag' },
		{ path: 'settings.end_tag.value', label: 'End Tag' },
		{ path: 'settings.output_type.value', label: 'Output Type' },
		{ path: 'prompts.system_prompt.value', label: 'System Prompt' },
		{ path: 'prompts.user_prefix.value', label: 'User Prefix' },
		{ path: 'prompts.user_request.value', label: 'User Request' }
	];

	for (const field of requiredFields) {
		const value = field.path.split('.').reduce((obj, key) => obj?.[key], agent);
		if (!value || value.trim() === '') {
			vscode.postMessage({
				command: 'showError',
				message: `${field.label} is required`
			});
			return false;
		}
	}

	return true;
}

function addPrefill(agent) {
	agent.settings.prefills.push({
		value: '',
		status: 'new'
	});
	renderAgentEditor(agent.id);
}

function removePrefill(agent, index) {
	agent.settings.prefills.splice(index, 1);
	renderAgentEditor(agent.id);
}

function escapeHtml(unsafe) {
	return unsafe
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// Message handling
window.addEventListener('message', event => {
	const message = event.data;
	vscode.postMessage({
		command: 'showInformationMessage',
		text: `Received message: ${message.command}`
	});

	switch (message.command) {
		case 'updateAgents':
			vscode.postMessage({
				command: 'showInformationMessage',
				text: `Updating agents: ${message.agents ? message.agents.length : 0} agents received`
			});
			state.agents = message.agents || [];
			vscode.setState(state);
			renderAgentList();
			if (state.selectedAgent) {
				renderAgentEditor(state.selectedAgent);
			}
			break;
		case 'updateTheme':
			updateTheme(message.theme);
			break;
		case 'showError':
			vscode.postMessage({
				command: 'showError',
				message: message.message
			});
			break;
		case 'agentSaved':
			vscode.postMessage({
				command: 'showInformationMessage',
				text: 'Agent saved successfully'
			});
			break;
	}
});

// Initial render
document.addEventListener('DOMContentLoaded', () => {
	vscode.postMessage({
		command: 'showInformationMessage',
		text: 'DOM Content Loaded'
	});

	// Check if elements exist
	const agentList = document.getElementById('agentList');
	const agentForm = document.getElementById('agentForm');

	vscode.postMessage({
		command: 'showInformationMessage',
		text: `Elements exist - AgentList: ${!!agentList}, AgentForm: ${!!agentForm}`
	});

	renderAgentList();
	if (state.selectedAgent) {
		vscode.postMessage({
			command: 'showInformationMessage',
			text: `Rendering selected agent: ${state.selectedAgent}`
		});
		renderAgentEditor(state.selectedAgent);
	}

	// Request initial data
	vscode.postMessage({
		command: 'showInformationMessage',
		text: 'Requesting initial data'
	});
	vscode.postMessage({ command: 'getAgents' });
	vscode.postMessage({ command: 'getTheme' });
});
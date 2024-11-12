import * as vscode from 'vscode';
import { log, initializeLogging } from './utils/logUtils';
import { AgentManager } from './agentManager';
import * as path from 'path';

const CHANNEL_NAME = 'Coauthor Agent Editor';
initializeLogging(CHANNEL_NAME);

export function registerAgentEditorCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('coauthor.openAgentEditor', () => {
			const category = 'Open-Editor';
			log(CHANNEL_NAME, category, 'Opening agent editor');

			const panel = vscode.window.createWebviewPanel(
				'coauthor.agentEditor',
				'Agent Editor',
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [
						vscode.Uri.joinPath(context.extensionUri, 'src', 'webview')
					]
				}
			);

			try {
				// Get paths to resources
				const webviewPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webview');
				
				const scriptUri = panel.webview.asWebviewUri(
					vscode.Uri.joinPath(webviewPath, 'agentEditor.js')
				);
				const styleUri = panel.webview.asWebviewUri(
					vscode.Uri.joinPath(webviewPath, 'agentEditor.css')
				);

				log(CHANNEL_NAME, category, `Script URI: ${scriptUri}`);
				log(CHANNEL_NAME, category, `Style URI: ${styleUri}`);
				log(CHANNEL_NAME, category, `Webview Path: ${webviewPath}`);

				// Set webview content
				panel.webview.html = getWebviewContent(panel.webview, scriptUri, styleUri);
				log(CHANNEL_NAME, category, 'Webview content set');

				// Create agent manager instance
				const agentManager = new AgentManager(context);

				// Handle messages from the webview
				panel.webview.onDidReceiveMessage(async message => {
					log(CHANNEL_NAME, category, `Received message: ${message.command}`);
					
					switch (message.command) {
						case 'showInformationMessage':
							log(CHANNEL_NAME, category, `Information: ${message.text}`);
							break;
						case 'showError':
							log(CHANNEL_NAME, category, `Error: ${message.message}`, true);
							vscode.window.showErrorMessage(message.message);
							break;
						case 'getAgents':
							try {
								const agents = Array.from(agentManager.getAgents().values());
								const resolvedAgents = await Promise.all(
									agents.map(agent => agentManager.resolveInheritance(agent))
								);
								
								log(CHANNEL_NAME, category, `Sending ${resolvedAgents.length} agents to webview`);
								panel.webview.postMessage({
									command: 'updateAgents',
									agents: resolvedAgents
								});
							} catch (error) {
								log(CHANNEL_NAME, category, `Error getting agents: ${error}`, true);
							}
							break;

						case 'getTheme':
							const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
								? 'dark'
								: 'light';
							log(CHANNEL_NAME, category, `Sending theme: ${theme}`);
							panel.webview.postMessage({
								command: 'updateTheme',
								theme: theme
							});
							break;

						case 'saveAgent':
							try {
								await agentManager.saveAgent(message.agent);
								log(CHANNEL_NAME, category, `Agent saved: ${message.agent.id}`);
								panel.webview.postMessage({
									command: 'agentSaved'
								});
							} catch (error) {
								log(CHANNEL_NAME, category, `Error saving agent: ${error}`, true);
								vscode.window.showErrorMessage(`Failed to save agent: ${error}`);
							}
							break;

						case 'showError':
							vscode.window.showErrorMessage(message.message);
							break;
					}
				});

			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				log(CHANNEL_NAME, category, `Error creating webview: ${errorMessage}`, true);
				vscode.window.showErrorMessage(`Failed to open agent editor: ${errorMessage}`);
			}
		}),

		vscode.commands.registerCommand('coauthor.createAgent', async () => {
			const name = await vscode.window.showInputBox({
				prompt: 'Enter new agent name',
				validateInput: (value) => {
					return value && value.length > 0 ? null : 'Agent name is required';
				}
			});
			if (name) {
				// Create new agent logic
			}
		}),

		vscode.commands.registerCommand('coauthor.exportAgent', async () => {
			const uri = await vscode.window.showSaveDialog({
				filters: {
					'XML files': ['xml']
				}
			});
			if (uri) {
				// Export agent logic
			}
		})
	);
}

function getWebviewContent(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri) {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<meta http-equiv="Content-Security-Policy" 
			  content="default-src 'none'; 
					   img-src ${webview.cspSource} https:; 
					   script-src ${webview.cspSource} 'unsafe-inline';
					   style-src ${webview.cspSource} 'unsafe-inline';">
		<link href="${styleUri}" rel="stylesheet">
		<title>Agent Editor</title>
	</head>
	<body>
		<div class="container">
			<div class="agent-list">
				<div class="editor-header">
					<h2>Agents</h2>
					<button id="newAgent" class="secondary-button">
						<i class="codicon codicon-add"></i>
						New Agent
					</button>
				</div>
				<div id="agentList"></div>
			</div>
			<div class="agent-editor">
				<div id="agentForm"></div>
			</div>
		</div>
		<script>
			const vscode = acquireVsCodeApi();
			vscode.postMessage({
				command: 'showInformationMessage',
				text: 'Initializing Agent Editor'
			});
		</script>
		<script type="module" src="${scriptUri}"></script>
	</body>
	</html>`;
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
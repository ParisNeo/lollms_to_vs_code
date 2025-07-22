import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type FileState = 'fullContent' | 'signatures' | 'excluded';

// --- CENTRAL STATE MANAGEMENT ---

class ContextStateManager {
    private static _instance: ContextStateManager;
    private _fileStates = new Map<string, FileState>();
    private _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
    public readonly onDidChange = this._onDidChange.event;
    private stateFilePath: string | undefined;

    private constructor() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this.stateFilePath = path.join(workspaceFolder.uri.fsPath, '.lollms', 'context_state.json');
            this.loadState().catch(e => console.error("Lollms: Failed to load initial state.", e));
        }
    }

    public static getInstance(): ContextStateManager {
        return this._instance || (this._instance = new ContextStateManager());
    }

    public getState(uri: vscode.Uri): FileState | 'treeOnly' {
        if (this._fileStates.get(uri.toString()) === 'excluded') {
            return 'excluded';
        }
        let currentPath = uri.fsPath;
        let parentPath = path.dirname(currentPath);
        while (parentPath !== currentPath) {
            if (this._fileStates.get(vscode.Uri.file(parentPath).toString()) === 'excluded') {
                return 'excluded';
            }
            currentPath = parentPath;
            parentPath = path.dirname(currentPath);
        }
        return this._fileStates.get(uri.toString()) || 'treeOnly';
    }
    
    public async cycleState(uri: vscode.Uri): Promise<void> {
        const currentState = this._fileStates.get(uri.toString());
        let nextState: FileState | 'treeOnly' = 'fullContent';
        if (currentState === 'fullContent') {
            nextState = 'signatures';
        } else if (currentState === 'signatures') {
            nextState = 'treeOnly';
        }
        await this.setState([uri], nextState);
    }

    public async setState(uris: vscode.Uri[], state: FileState | 'treeOnly'): Promise<void> {
        const allFileUris = await getAllFileUris(uris);
        allFileUris.forEach(uri => {
            if (state === 'treeOnly') {
                this._fileStates.delete(uri.toString());
            } else {
                this._fileStates.set(uri.toString(), state);
            }
        });
        await this.saveState();
        this._onDidChange.fire(allFileUris);
    }

    private async saveState(): Promise<void> {
        if (!this.stateFilePath) { return; }
        try {
            const dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = JSON.stringify(Array.from(this._fileStates.entries()));
            await vscode.workspace.fs.writeFile(vscode.Uri.file(this.stateFilePath), Buffer.from(data, 'utf-8'));
        } catch (e) {
            console.error("Lollms: Failed to save state.", e);
            vscode.window.showErrorMessage(`Lollms: Failed to save context state.`);
        }
    }

    private async loadState(): Promise<void> {
        if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) { return; }
        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.stateFilePath));
            const entries = JSON.parse(Buffer.from(data).toString('utf-8')) as [string, FileState][];
            this._fileStates = new Map<string, FileState>(entries);
            this._onDidChange.fire([]);
        } catch (e) {
            console.error("Lollms: Failed to load state. Resetting.", e);
            this._fileStates = new Map();
            vscode.window.showErrorMessage(`Lollms: Could not load context state from .lollms folder.`);
        }
    }
}

// --- FILE DECORATION PROVIDER ---

class LollmsFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly stateManager = ContextStateManager.getInstance();
    private _disposables: vscode.Disposable[];
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor() {
        this._disposables = [
            this.stateManager.onDidChange((uris) => this._onDidChangeFileDecorations.fire(uris.length > 0 ? uris : undefined))
        ];
    }

    provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
        const state = this.stateManager.getState(uri);
        switch (state) {
            case 'fullContent': return new vscode.FileDecoration('+', 'Include Full Content', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
            case 'signatures': return new vscode.FileDecoration('S', 'Include Signatures Only', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
            case 'excluded': return new vscode.FileDecoration('✗', 'Excluded from Context', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
            default: return undefined;
        }
    }
    dispose(): void { this._disposables.forEach(d => d.dispose()); }
}

// --- SIDEBAR TREE PROVIDER ---

class LollmsSidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly stateManager = ContextStateManager.getInstance();
    private _disposables: vscode.Disposable[];
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor() {
        this._disposables = [this.stateManager.onDidChange(() => this._onDidChangeTreeData.fire())];
    }
    
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return [new vscode.TreeItem("Please open a folder to use Lollms.")]; }
        
        const rootUri = element ? element.resourceUri! : workspaceFolders[0].uri;
        return this.getDirectoryContents(rootUri);
    }

    private async getDirectoryContents(dirUri: vscode.Uri): Promise<vscode.TreeItem[]> {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        const items: vscode.TreeItem[] = [];
        for (const [name, type] of entries) {
            const uri = vscode.Uri.joinPath(dirUri, name);
            if (this.stateManager.getState(uri) === 'excluded') { continue; }
            
            const isDirectory = type === vscode.FileType.Directory;
            const collapsibleState = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
            const item = new vscode.TreeItem(name, collapsibleState);
            item.resourceUri = uri;
            item.command = { command: 'lollms_to_vs_code.cycleContextState', title: "Cycle State", arguments: [uri] };

            const state = this.stateManager.getState(uri);
            switch (state) {
                case 'fullContent': item.description = "[+]"; item.iconPath = new vscode.ThemeIcon('file-code'); break;
                case 'signatures': item.description = "[S]"; item.iconPath = new vscode.ThemeIcon('symbol-function'); break;
                default: item.iconPath = isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File; break;
            }
            items.push(item);
        }
        return items.sort((a, b) => {
            const aIsDir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
            const bIsDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
            if (aIsDir !== bIsDir) { return aIsDir ? -1 : 1; }
            const aLabel = typeof a.label === 'string' ? a.label : a.label?.label || '';
            const bLabel = typeof b.label === 'string' ? b.label : b.label?.label || '';
            return aLabel.localeCompare(bLabel);
        });
    }
    dispose(): void { this._disposables.forEach(d => d.dispose()); }
}


// --- WEBVIEW CONTROL PANEL ---
class LollmsControlPanel {
    public static currentPanel: LollmsControlPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    
    public static createOrShow(extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Beside;
        if (LollmsControlPanel.currentPanel) {
            LollmsControlPanel.currentPanel._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('lollmsControlPanel', 'Lollms Control Panel', column, {
            enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
        });
        LollmsControlPanel.currentPanel = new LollmsControlPanel(panel, extensionUri);
    }
    
    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (message: any) => {
            const stateManager = ContextStateManager.getInstance();
            switch (message.command) {
                case 'generateContextRequest':
                    await this.handleGenerateContext(message.payload);
                    return;
                case 'chatRequest':
                    await this.handleChatRequest(message.payload);
                    return;
                case 'removeFile': 
                    await stateManager.setState([vscode.Uri.file(message.path)], 'treeOnly');
                    await vscode.commands.executeCommand('lollms_to_vs_code.generateContext');
                    return;
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'lollms');
                    return;
            }
        });
    }

    public postMessage(message: any): void {
        this._panel.webview.postMessage(message);
    }
    
    private async handleGenerateContext(payload: { custom_prompt: string }): Promise<void> {
        this.postMessage({ command: 'contextLoading' });
        const stateManager = ContextStateManager.getInstance();
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            this.postMessage({ command: 'response:generateContext', error: 'No folder is open.' });
            return;
        }
        const rootUri = workspaceFolders[0].uri;
        const allFiles = await getAllFileUris([rootUri]);

        const includedFilesInTree = allFiles.filter(uri => stateManager.getState(uri) !== 'excluded');
        const mdTree = generateMarkdownTreeFromUris(includedFilesInTree, rootUri);
        
        const fileContents: string[] = [];
        for (const uri of includedFilesInTree) {
            const state = stateManager.getState(uri);
            if (state === 'fullContent' || state === 'signatures') {
                const relativePath = path.relative(rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
                fileContents.push(`### \`${relativePath}\``);
                try {
                    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
                    const processedContent = state === 'signatures' ? extractSignatures(content, path.extname(uri.fsPath)) : content;
                    fileContents.push(`\`\`\`${path.extname(uri.fsPath).substring(1) || 'text'}\n${processedContent}\n\`\`\``);
                } catch (e: any) {
                    fileContents.push(`\`\`\`\nError reading file: ${e.message}\n\`\`\``);
                }
            }
        }
        
        const finalMd = [
            "## Custom Instructions", payload.custom_prompt || "No custom instructions provided.",
            "---", "## Project Tree", `\`\`\`text\n${mdTree}\n\`\`\``,
            "---", "## File Contents", fileContents.join('\n\n') || "No files included with full content or signatures."
        ].join('\n\n');

        this.postMessage({ command: 'response:generateContext', markdown: finalMd, files: includedFilesInTree.map(u => u.fsPath) });
    }

    private async handleChatRequest(payload: { messages: any[] }): Promise<void> {
        const config = vscode.workspace.getConfiguration('lollms');
        const host = config.get<string>('host');
        if (!host) {
            this.postMessage({ command: 'chatError', error: 'Lollms host not configured.' });
            return;
        }
        try {
            const response = await fetch(`${host}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(config.get<string>('apiKey') ? { 'Authorization': `Bearer ${config.get('apiKey')}` } : {}) },
                body: JSON.stringify({ messages: payload.messages, stream: true, temperature: 0.1, top_p: 0.95 })
            });
            if (!response.ok || !response.body) {
                throw new Error(`API error: ${response.status}`);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) { break; }
                decoder.decode(value).split('\n\n').filter(l => l.startsWith('data: ')).forEach(l => {
                    const jsonStr = l.substring(5);
                    if (jsonStr.trim() === '[DONE]') { return; }
                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.choices?.[0]?.delta?.content) {
                           this.postMessage({ command: 'chatChunk', chunk: parsed.choices[0].delta.content });
                        }
                    } catch (e) {
                        console.error("Lollms: Failed to parse stream chunk:", jsonStr);
                    }
                });
            }
        } catch (e: any) {
            this.postMessage({ command: 'chatError', error: e.message });
        }
        this.postMessage({ command: 'chatEnd' });
    }

    public dispose(): void {
        LollmsControlPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }
    
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.css'));
        const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'toolkit.js'));
        const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'marked.min.js'));
        const nonce = getNonce();
        const htmlTemplate = fs.readFileSync(vscode.Uri.joinPath(this._extensionUri, 'media', 'WebviewPanel.html').fsPath, 'utf8');

        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${styleUri}" rel="stylesheet"><script type="module" nonce="${nonce}" src="${toolkitUri}"></script><script nonce="${nonce}" src="${markedUri}"></script><title>Lollms</title></head><body>${htmlTemplate}<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
    }
}


// --- MAIN ACTIVATION ---
export function activate(context: vscode.ExtensionContext): void {
    const stateManager = ContextStateManager.getInstance();
    
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(new LollmsFileDecorationProvider()));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollms-sidebar', new LollmsSidebarProvider()));

    const commands: { [key: string]: (...args: any[]) => any } = {
        'lollms_to_vs_code.openPanel': () => LollmsControlPanel.createOrShow(context.extensionUri),
        'lollms_to_vs_code.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', 'lollms'),
        'lollms_to_vs_code.cycleContextState': (uri: vscode.Uri) => stateManager.cycleState(uri),
        'lollms_to_vs_code.setContextFull': (uriOrTreeItem: vscode.Uri | vscode.TreeItem, uris?: vscode.Uri[]) => stateManager.setState(uris || [uriOrTreeItem instanceof vscode.Uri ? uriOrTreeItem : uriOrTreeItem.resourceUri!], 'fullContent'),
        'lollms_to_vs_code.setContextSignatures': (uriOrTreeItem: vscode.Uri | vscode.TreeItem, uris?: vscode.Uri[]) => stateManager.setState(uris || [uriOrTreeItem instanceof vscode.Uri ? uriOrTreeItem : uriOrTreeItem.resourceUri!], 'signatures'),
        'lollms_to_vs_code.setContextTreeOnly': (uriOrTreeItem: vscode.Uri | vscode.TreeItem, uris?: vscode.Uri[]) => stateManager.setState(uris || [uriOrTreeItem instanceof vscode.Uri ? uriOrTreeItem : uriOrTreeItem.resourceUri!], 'treeOnly'),
        'lollms_to_vs_code.setContextExcluded': (uriOrTreeItem: vscode.Uri | vscode.TreeItem, uris?: vscode.Uri[]) => stateManager.setState(uris || [uriOrTreeItem instanceof vscode.Uri ? uriOrTreeItem : uriOrTreeItem.resourceUri!], 'excluded'),
        'lollms_to_vs_code.generateContext': () => {
            const panel = LollmsControlPanel.currentPanel;
            if (!panel) {
                LollmsControlPanel.createOrShow(context.extensionUri);
                setTimeout(() => {
                    LollmsControlPanel.currentPanel?.postMessage({ command: 'requestAndGenerateContext' });
                }, 300);
            } else {
                 panel.postMessage({ command: 'requestAndGenerateContext' });
            }
        }
    };
    
    Object.entries(commands).forEach(([cmd, handler]) => {
        context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
    });
}

export function deactivate(): void {}

// --- HELPER FUNCTIONS ---
async function getAllFileUris(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    const fileUris: vscode.Uri[] = [];
    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.File) {
                fileUris.push(uri);
            } else if (stat.type === vscode.FileType.Directory) {
                const filesInDir = await vscode.workspace.fs.readDirectory(uri);
                const nestedUris = filesInDir.map(([name]) => vscode.Uri.joinPath(uri, name));
                fileUris.push(...await getAllFileUris(nestedUris));
            }
        } catch (e) { console.error(`Lollms: Could not process URI: ${uri.toString()}`, e); }
    }
    return fileUris;
}

function getNonce(): string { let t = ''; for (let i = 0; i < 32; i++) { t += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62)); } return t; }

function findCommonBasePath(files: string[]): string { if (!files || files.length === 0) { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; } if (files.length === 1) { return path.dirname(files[0]); } const sorted = [...files].sort(); const first = sorted[0].split(path.sep); const last = sorted[sorted.length - 1].split(path.sep); let i = 0; while (i < first.length && first[i] === last[i]) { i++; } return first.slice(0, i).join(path.sep); }

function extractSignatures(code: string, extension: string): string {
    if (extension === '.py') {
        const lines = code.split('\n');
        const signatures = [];
        const classRegex = /^\s*class\s+([a-zA-Z_]\w*)/;
        const funcRegex = /^\s*(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\((.*?)\):/;
        for (const line of lines) {
            const classMatch = line.match(classRegex);
            if (classMatch) { signatures.push(`class ${classMatch[1]}: ...`); continue; }
            const funcMatch = line.match(funcRegex);
            if (funcMatch) { signatures.push(funcMatch[0].replace(/:\s*$/, '')); }
        }
        return signatures.join('\n') || "No Python signatures found.";
    }
    if (['.js', '.ts', '.jsx', '.tsx'].includes(extension)) {
        const signatures = [];
        const patterns = [
            /^(?:export\s+)?(async\s+)?function\s+([\w$]+)\s*\(.*?\)/gm,
            /^(?:export\s+)?class\s+([\w$]+)/gm,
            /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async)?\s*\(.*?\)\s*=>/gm
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                signatures.push(match[0].replace(/\s*=\s*.*$/, ''));
            }
        }
        return signatures.join('\n') || "No JavaScript/TypeScript signatures found.";
    }
    return "Signature extraction not supported for this file type.";
}

function generateMarkdownTreeFromUris(uris: vscode.Uri[], rootUri: vscode.Uri): string {
    const stateManager = ContextStateManager.getInstance();
    type FileTree = { [key: string]: FileTree };
    const tree: FileTree = {};
    uris.forEach(uri => {
        const relativePath = path.relative(rootUri.fsPath, uri.fsPath);
        if (relativePath) {
            relativePath.split(path.sep).reduce((level, part) => (level[part] = level[part] || {}), tree);
        }
    });

    function buildLines(level: FileTree, currentPath: vscode.Uri): string[] {
        const entries = Object.keys(level).sort();
        return entries.flatMap((entry, i) => {
            const uri = vscode.Uri.joinPath(currentPath, entry);
            const state = stateManager.getState(uri);
            let badge = '';
            switch (state) {
                case 'fullContent': badge = ' [+]'; break;
                case 'signatures': badge = ' [S]'; break;
            }
            const isLast = i === entries.length - 1;
            const newPrefix = isLast ? '└─ ' : '├─ ';
            const isDir = Object.keys(level[entry]).length > 0;
            const subLines = isDir ? buildLines(level[entry], uri) : [];
            const icon = isDir ? '📁' : '📄';
            return [`${newPrefix}${icon} ${entry}${badge}`, ...subLines.map(s => (isLast ? '   ' : '│  ') + s)];
        });
    }
    const rootName = path.basename(rootUri.fsPath) || vscode.workspace.name || 'Project';
    return [`📁 ${rootName}/`, ...buildLines(tree, rootUri)].join('\n');
}
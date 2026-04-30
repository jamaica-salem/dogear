// src/snapshotService.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { FocusSession, OpenFile, GitContext, TerminalContext, TerminalTab } from './types';

export class SnapshotService {
  private storageDir: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly terminalRuntime = new Map<vscode.Terminal, {
    lastCommand?: string;
    lastCwd?: string;
  }>();

  constructor(workspaceRoot: string) {
    this.storageDir = path.join(workspaceRoot, '.vscode', 'focus');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    this.disposables.push(
      vscode.window.onDidChangeTerminalShellIntegration(event => {
        const data = this.getOrCreateTerminalRuntime(event.terminal);
        data.lastCwd = event.shellIntegration.cwd?.fsPath ?? data.lastCwd;
      }),
      vscode.window.onDidStartTerminalShellExecution(event => {
        const data = this.getOrCreateTerminalRuntime(event.terminal);
        data.lastCommand = this.cleanCommand(event.execution.commandLine.value) ?? data.lastCommand;
        data.lastCwd = event.execution.cwd?.fsPath ?? event.shellIntegration.cwd?.fsPath ?? data.lastCwd;
      }),
      vscode.window.onDidCloseTerminal(terminal => {
        this.terminalRuntime.delete(terminal);
      })
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  async capture(name: string): Promise<FocusSession> {
    const editor = await this.captureEditorState();
    const git = await this.captureGitContext();
    const terminal = await this.captureTerminalContext();
    const cursorContext = await this.readCursorContext(editor.openFiles[0]);

    const session: FocusSession = {
      id: crypto.randomUUID(),
      name,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '',
      createdAt: new Date().toISOString(),
      editor,
      git,
      terminal,
      aiSummary: '',        // filled in by AiService after capture
      cursorContext,
    };

    return session;
  }

  save(session: FocusSession): void {
    const filePath = path.join(this.storageDir, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  }

  listAll(): FocusSession[] {
    if (!fs.existsSync(this.storageDir)) { return []; }
    return fs.readdirSync(this.storageDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(this.storageDir, f), 'utf8')) as FocusSession)
      .map(session => ({
        ...session,
        terminal: this.normalizeTerminalContext(session.terminal),
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  delete(id: string): void {
    const filePath = path.join(this.storageDir, `${id}.json`);
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
  }

  private async captureEditorState() {
    const editors = vscode.window.visibleTextEditors;
    const openFiles: OpenFile[] = editors.map(e => ({
      uri: e.document.uri.toString(),
      cursorLine: e.selection.active.line,
      cursorCharacter: e.selection.active.character,
      scrollTop: e.visibleRanges[0]?.start.line ?? 0,
      viewColumn: e.viewColumn ?? 1,
    }));

    // Also capture all tabs (including those not currently visible)
    const allTabs: OpenFile[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText) {
          const tabUri = input.uri.toString();
          const alreadyCaptured = openFiles.find(f => f.uri === tabUri);
          if (!alreadyCaptured) {
            allTabs.push({
              uri: tabUri,
              cursorLine: 0,
              cursorCharacter: 0,
              scrollTop: 0,
              viewColumn: group.viewColumn,
            });
          }
        }
      }
    }

    const groups = vscode.window.tabGroups.all.length;
    const splitLayout =
      groups >= 3 ? 'three-columns' :
      groups === 2 ? 'two-columns' : 'single';

    return {
      openFiles: [...openFiles, ...allTabs],
      activeFileUri: vscode.window.activeTextEditor?.document.uri.toString() ?? '',
      splitLayout,
    };
  }

  private async captureGitContext(): Promise<GitContext> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) { return this.emptyGit(); }
      const git = gitExtension.exports.getAPI(1);
      const repo = git.repositories[0];
      if (!repo) { return this.emptyGit(); }

      const branch = repo.state.HEAD?.name ?? 'unknown';

      // Last 5 commits
      const log = await repo.log({ maxEntries: 5 });
      const recentCommits = log.map((c: any) =>
        `${c.hash.slice(0, 7)} ${c.message.split('\n')[0]}`
      );

      // Diff stat against HEAD
      const changes = repo.state.workingTreeChanges;
      const staged = repo.state.indexChanges;
      const diffStat = `${changes.length} working tree change(s), ${staged.length} staged`;

      return {
        branch,
        recentCommits,
        diffStat,
        stagedFiles: staged.map((c: any) => c.uri.fsPath),
      };
    } catch {
      return this.emptyGit();
    }
  }

  private emptyGit(): GitContext {
    return { branch: '', recentCommits: [], diffStat: '', stagedFiles: [] };
  }

  private async captureTerminalContext(): Promise<TerminalContext> {
    const config = vscode.workspace.getConfiguration('focusMode');
    const captureLastCommand = config.get<boolean>('captureTerminalLastCommand', true);
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '';

    const tabs: TerminalTab[] = vscode.window.terminals.map(terminal => {
      const runtime = this.terminalRuntime.get(terminal);
      const shellPath = this.extractShellPath(terminal);
      const lastCommand = captureLastCommand ? this.cleanCommand(runtime?.lastCommand) : undefined;

      return {
        name: terminal.name,
        cwd: this.resolveTerminalCwd(terminal, runtime?.lastCwd, workspaceCwd),
        shellType: this.detectShellType(shellPath, terminal.name),
        shellPath,
        ...(lastCommand ? { lastCommand } : {}),
      };
    });

    const activeTerminal = vscode.window.activeTerminal;
    const activeTabName = activeTerminal?.name ?? '';
    const activeTabIndex = activeTerminal ? vscode.window.terminals.findIndex(terminal => terminal === activeTerminal) : -1;
    const lastCommands = tabs
      .map(tab => tab.lastCommand)
      .filter((command): command is string => typeof command === 'string' && command.length > 0);

    return {
      cwd: tabs.find(tab => tab.name === activeTabName)?.cwd ?? workspaceCwd,
      lastCommands,
      tabs,
      activeTabName,
      activeTabIndex,
    };
  }

  private normalizeTerminalContext(raw: TerminalContext | undefined): TerminalContext {
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '';
    const hasLegacyContext = typeof raw?.cwd === 'string' || Array.isArray(raw?.lastCommands) || Array.isArray(raw?.tabs);
    const legacyCwd = typeof raw?.cwd === 'string' ? raw.cwd : workspaceCwd;
    const legacyCommands = Array.isArray(raw?.lastCommands)
      ? raw.lastCommands.filter((command): command is string => typeof command === 'string' && command.length > 0)
      : [];

    const tabs = Array.isArray((raw as TerminalContext | undefined)?.tabs)
      ? (raw?.tabs ?? []).map(tab => ({
        name: typeof tab.name === 'string' ? tab.name : 'Terminal',
        cwd: typeof tab.cwd === 'string' ? tab.cwd : legacyCwd,
        shellType: typeof tab.shellType === 'string' && tab.shellType.length > 0 ? tab.shellType : 'default',
        shellPath: typeof tab.shellPath === 'string' ? tab.shellPath : '',
        ...(typeof tab.lastCommand === 'string' && tab.lastCommand.length > 0
          ? { lastCommand: tab.lastCommand }
          : {}),
      }))
      : [];

    if (tabs.length === 0 && hasLegacyContext && legacyCwd) {
      tabs.push({
        name: 'Terminal',
        cwd: legacyCwd,
        shellType: 'default',
        shellPath: '',
      });
    }

    const activeTabName = typeof raw?.activeTabName === 'string' && raw.activeTabName.length > 0
      ? raw.activeTabName
      : tabs[0]?.name ?? '';
    const derivedActiveIndex = tabs.findIndex(tab => tab.name === activeTabName);
    const activeTabIndex = typeof raw?.activeTabIndex === 'number'
      ? raw.activeTabIndex
      : derivedActiveIndex;
    const lastCommands = tabs
      .map(tab => tab.lastCommand)
      .filter((command): command is string => typeof command === 'string' && command.length > 0);

    return {
      cwd: legacyCwd,
      lastCommands: lastCommands.length > 0 ? lastCommands : legacyCommands,
      tabs,
      activeTabName,
      activeTabIndex,
    };
  }

  private getOrCreateTerminalRuntime(terminal: vscode.Terminal): { lastCommand?: string; lastCwd?: string } {
    const existing = this.terminalRuntime.get(terminal);
    if (existing) {
      return existing;
    }

    const created = {
      lastCwd: this.resolveCreationCwd(terminal.creationOptions),
    };
    this.terminalRuntime.set(terminal, created);
    return created;
  }

  private extractShellPath(terminal: vscode.Terminal): string {
    const creationOptions = terminal.creationOptions;
    if ('shellPath' in creationOptions && typeof creationOptions.shellPath === 'string') {
      return creationOptions.shellPath;
    }
    return '';
  }

  private resolveCreationCwd(creationOptions: Readonly<vscode.TerminalOptions | vscode.ExtensionTerminalOptions>): string {
    if ('cwd' in creationOptions) {
      const cwd = creationOptions.cwd;
      if (typeof cwd === 'string') {
        return cwd;
      }
      if (cwd instanceof vscode.Uri) {
        return cwd.fsPath;
      }
    }
    return '';
  }

  private resolveTerminalCwd(
    terminal: vscode.Terminal,
    runtimeCwd: string | undefined,
    workspaceCwd: string
  ): string {
    const integrationCwd = terminal.shellIntegration?.cwd?.fsPath;
    if (integrationCwd) {
      return integrationCwd;
    }

    const creationCwd = this.resolveCreationCwd(terminal.creationOptions);
    if (creationCwd) {
      return creationCwd;
    }

    if (runtimeCwd) {
      return runtimeCwd;
    }

    return workspaceCwd;
  }

  private detectShellType(shellPath: string, terminalName: string): string {
    if (shellPath) {
      return path.basename(shellPath).replace(/\.exe$/i, '').toLowerCase();
    }

    const lowerName = terminalName.toLowerCase();
    const knownShells = ['bash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'sh'];
    for (const shell of knownShells) {
      if (lowerName.includes(shell)) {
        return shell;
      }
    }

    return 'default';
  }

  private cleanCommand(command: string | undefined): string | undefined {
    if (!command) {
      return undefined;
    }
    const trimmed = command.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private async readCursorContext(file?: OpenFile): Promise<string> {
    if (!file) { return ''; }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(file.uri));
      const start = Math.max(0, file.cursorLine - 25);
      const end = Math.min(doc.lineCount, file.cursorLine + 25);
      const lines: string[] = [];
      for (let i = start; i < end; i++) {
        lines.push(doc.lineAt(i).text);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}

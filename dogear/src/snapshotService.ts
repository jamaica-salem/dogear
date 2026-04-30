// src/snapshotService.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { FocusSession, OpenFile, GitContext, TerminalContext } from './types';

export class SnapshotService {
  private storageDir: string;

  constructor(workspaceRoot: string) {
    this.storageDir = path.join(workspaceRoot, '.vscode', 'focus');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
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
      .map(f => JSON.parse(fs.readFileSync(path.join(this.storageDir, f), 'utf8')))
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
    // VS Code doesn't expose terminal history — we store cwd only
    const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '';
    return { cwd, lastCommands: [] };
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

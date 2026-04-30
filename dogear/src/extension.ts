import * as vscode from 'vscode';
import { SnapshotService } from './snapshotService';
import { RestoreService } from './restoreService';
import { AiService } from './aiService';
import { SessionTreeProvider } from './sessionTreeProvider';
import { ReentryPanel } from './reentryPanel';
import { FocusSession } from './types';

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '';
  const snapshotService = new SnapshotService(workspaceRoot);
  const restoreService = new RestoreService();
  const aiService = new AiService();
  const treeProvider = new SessionTreeProvider(snapshotService);

  // Sidebar
  const treeViewDisposable = vscode.window.registerTreeDataProvider('focusModeSessionList', treeProvider);

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(record) Focus';
  statusBar.tooltip = 'Pause and save your session context';
  statusBar.command = 'focusMode.pause';
  statusBar.show();
  context.subscriptions.push(statusBar, treeViewDisposable, snapshotService);

  // ── PAUSE command ──────────────────────────────────────────
  const pauseCmd = vscode.commands.registerCommand('focusMode.pause', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Name this session (press Enter for auto-name)',
      placeHolder: 'e.g. auth-refactor',
    });
    if (name === undefined) { return; } // user pressed Escape

    const sessionName = name.trim() || `session-${new Date().toISOString().slice(0, 16)}`;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Saving session…', cancellable: false },
      async () => {
        const session = await snapshotService.capture(sessionName);

        // Generate AI summary (non-blocking — save first, update after)
        snapshotService.save(session);
        treeProvider.refresh();

        try {
          const summary = await aiService.generateSummary(session);
          session.aiSummary = summary;
          snapshotService.save(session); // overwrite with summary
          treeProvider.refresh();
        } catch (e) {
          session.aiSummary = 'AI summary unavailable — check your API key in settings.';
          snapshotService.save(session);
        }
      }
    );

    vscode.window.showInformationMessage(`Session "${sessionName}" saved.`);
  });

  // ── RESUME command ─────────────────────────────────────────
  const resumeCmd = vscode.commands.registerCommand('focusMode.resume', async (session?: FocusSession) => {
    if (!session) {
      // Called from command palette — show quick pick
      const sessions = snapshotService.listAll();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No saved sessions. Use "Focus: Pause" to save one.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        sessions.map(s => ({ label: s.name, description: new Date(s.createdAt).toLocaleString(), session: s })),
        { placeHolder: 'Select a session to resume' }
      );
      if (!picked) { return; }
      session = picked.session;
    }

    ReentryPanel.show(session);
    await restoreService.restore(session);
  });

  // ── DELETE command ─────────────────────────────────────────
  const deleteCmd = vscode.commands.registerCommand('focusMode.deleteSession', async (item: any) => {
    const session: FocusSession = item?.session ?? item;
    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${session.name}"?`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      snapshotService.delete(session.id);
      treeProvider.refresh();
    }
  });

  context.subscriptions.push(pauseCmd, resumeCmd, deleteCmd);
}

export function deactivate() {}

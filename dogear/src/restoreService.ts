import * as vscode from 'vscode';
import { FocusSession, TerminalContext, TerminalTab } from './types';

export class RestoreService {
  async restore(session: FocusSession): Promise<void> {
    // 1. Close all current editors (optional — ask user first in production)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // 2. Reopen files in their original view columns
    for (const file of session.editor.openFiles) {
      try {
        const uri = vscode.Uri.parse(file.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: file.viewColumn,
          preserveFocus: true,
        });

        // Restore cursor position
        const position = new vscode.Position(file.cursorLine, file.cursorCharacter);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      } catch {
        // File may have moved — skip silently
      }
    }

    // 3. Recreate terminal tabs
    await this.restoreTerminals(session.terminal);

    // 4. Bring the active file into focus last
    if (session.editor.activeFileUri) {
      try {
        const uri = vscode.Uri.parse(session.editor.activeFileUri);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch { /* ignore */ }
    }
  }

  private async restoreTerminals(terminalContext: TerminalContext | undefined): Promise<void> {
    if (!terminalContext) {
      return;
    }

    const tabs = terminalContext.tabs.length > 0
      ? terminalContext.tabs
      : this.legacyTerminalTabs(terminalContext);
    if (tabs.length === 0) {
      return;
    }

    await vscode.commands.executeCommand('workbench.action.terminal.killAll');

    const restoreLastCommand = vscode.workspace.getConfiguration('focusMode')
      .get<boolean>('restoreTerminalLastCommand', false);

    const createdTerminals: Array<{ terminal: vscode.Terminal; tab: TerminalTab }> = [];
    for (const tab of tabs) {
      const terminal = vscode.window.createTerminal({
        name: tab.name || 'Terminal',
        cwd: tab.cwd || terminalContext.cwd || undefined,
        ...(tab.shellPath ? { shellPath: tab.shellPath } : {}),
      });
      terminal.show(true);
      createdTerminals.push({ terminal, tab });
    }

    if (restoreLastCommand) {
      for (const item of createdTerminals) {
        if (item.tab.lastCommand) {
          await this.replayLastCommand(item.terminal, item.tab.lastCommand);
        }
      }
    }

    const activeByIndex = createdTerminals[terminalContext.activeTabIndex];
    if (activeByIndex) {
      activeByIndex.terminal.show(true);
      return;
    }

    const activeByName = createdTerminals.find(item => item.tab.name === terminalContext.activeTabName);
    if (activeByName) {
      activeByName.terminal.show(true);
    }
  }

  private legacyTerminalTabs(terminalContext: TerminalContext): TerminalTab[] {
    if (!terminalContext.cwd) {
      return [];
    }
    return [{
      name: terminalContext.activeTabName || 'Terminal',
      cwd: terminalContext.cwd,
      shellType: 'default',
      shellPath: '',
    }];
  }

  private async replayLastCommand(terminal: vscode.Terminal, command: string): Promise<void> {
    const timeoutMs = 3_000;
    const pollMs = 100;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (terminal.shellIntegration) {
        try {
          terminal.shellIntegration.executeCommand(command);
          return;
        } catch {
          break;
        }
      }
      await this.sleep(pollMs);
    }

    // Fallback when shell integration isn't available.
    terminal.sendText(command, true);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

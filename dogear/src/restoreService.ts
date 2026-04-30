import * as vscode from 'vscode';
import { FocusSession } from './types';

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

    // 3. Bring the active file into focus last
    if (session.editor.activeFileUri) {
      try {
        const uri = vscode.Uri.parse(session.editor.activeFileUri);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch { /* ignore */ }
    }
  }
}
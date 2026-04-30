import * as vscode from 'vscode';
import { FocusSession } from './types';
import { SnapshotService } from './snapshotService';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: FocusSession) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    const date = new Date(session.createdAt);
    this.description = date.toLocaleString();
    this.tooltip = session.aiSummary;
    this.iconPath = new vscode.ThemeIcon('history');
    this.command = {
      command: 'focusMode.resume',
      title: 'Resume Session',
      arguments: [session],
    };
    this.contextValue = 'focusSession';
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private snapshotService: SnapshotService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionTreeItem[] {
    return this.snapshotService.listAll().map(s => new SessionTreeItem(s));
  }
}
import * as vscode from 'vscode';
import { FocusSession } from './types';

export class ReentryPanel {
  static show(session: FocusSession): void {
    const panel = vscode.window.createWebviewPanel(
      'focusModeReentry',
      `Resuming: ${session.name}`,
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );

    panel.webview.html = ReentryPanel.buildHtml(session);

    // Auto-close after 60 seconds
    setTimeout(() => {
      try { panel.dispose(); } catch { /* already closed */ }
    }, 60_000);
  }

  private static buildHtml(session: FocusSession): string {
    const date = new Date(session.createdAt).toLocaleString();
    const files = session.editor.openFiles
      .map(f => {
        const name = f.uri.split('/').pop() ?? f.uri;
        return `<li>${name} <span class="line">line ${f.cursorLine + 1}</span></li>`;
      })
      .join('');

    const commits = session.git.recentCommits
      .slice(0, 3)
      .map(c => `<li>${c}</li>`)
      .join('');

    const terminalTabs = session.terminal?.tabs?.length
      ? session.terminal.tabs
      : (session.terminal?.cwd
        ? [{ name: 'Terminal', cwd: session.terminal.cwd, shellType: 'default', shellPath: '', lastCommand: undefined }]
        : []);
    const terminals = terminalTabs
      .map(tab => {
        const lastCommand = tab.lastCommand
          ? `<div class="line">Last command: <code>${tab.lastCommand}</code></div>`
          : '';
        return `<li>${tab.name} <span class="line">${tab.shellType} · ${tab.cwd}</span>${lastCommand}</li>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 640px; }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 24px; }
  h2 { font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
  .summary { line-height: 1.7; padding: 16px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; }
  ul { margin: 0; padding: 0 0 0 18px; line-height: 1.8; }
  .line { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .branch { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; padding: 2px 8px; font-size: 12px; }
</style>
</head>
<body>
<h1>${session.name}</h1>
<p class="meta">Saved ${date} &nbsp;·&nbsp; <span class="branch">${session.git.branch || 'no branch'}</span></p>

<h2>Where you left off</h2>
<p class="summary">${session.aiSummary || 'No summary available.'}</p>

<h2>Open files</h2>
<ul>${files || '<li>None recorded</li>'}</ul>

<h2>Recent commits</h2>
<ul>${commits || '<li>None recorded</li>'}</ul>

<h2>Terminals</h2>
<ul>${terminals || '<li>None recorded</li>'}</ul>
</body>
</html>`;
  }
}

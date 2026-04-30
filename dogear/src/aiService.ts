import OpenAI from 'openai';
import { FocusSession } from './types';
import * as vscode from 'vscode';

export class AiService {
  private client: OpenAI;

  constructor() {
    const apiKey = vscode.workspace.getConfiguration('focusMode').get<string>('groqApiKey') ?? '';
    // Groq is OpenAI-compatible — just swap the baseURL
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }

  async generateSummary(session: Omit<FocusSession, 'aiSummary'>): Promise<string> {
    const terminalTabs = session.terminal.tabs
      .slice(0, 3)
      .map(tab => `${tab.name} (${tab.shellType} @ ${tab.cwd})${tab.lastCommand ? ` last: ${tab.lastCommand}` : ''}`)
      .join(' | ');

    const prompt = `
You are helping a developer re-enter a coding session after an interruption.
Write a 3–4 sentence "where you left off" summary they can read in 10 seconds.

Rules:
- Be specific: mention actual file names and function names from the context.
- Write in second person ("You were working on…").
- End with the single most important next action.
- Do not use bullet points. Plain prose only.

Session context:
- Branch: ${session.git.branch || 'unknown'}
- Active file: ${session.editor.activeFileUri}
- Recent commits: ${session.git.recentCommits.slice(0, 3).join(' | ') || 'none'}
- Changes: ${session.git.diffStat}
- Staged files: ${session.git.stagedFiles.join(', ') || 'none'}
- Terminals: ${terminalTabs || 'none'}

Code around cursor:
\`\`\`
${session.cursorContext}
\`\`\`
`.trim();

    const response = await this.client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',  // fast + GPT-4o-level quality on Groq
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.choices[0].message.content ?? '';
  }
}

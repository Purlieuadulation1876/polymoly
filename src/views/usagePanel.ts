import { resolveLanguage, t, webviewI18nScript } from '../i18n';
import * as vscode from 'vscode';
import { UsageService } from '../usage/usageService';
import { randomNonce } from './chatViewProvider';

/** Webview panel with one card per provider: account, tokens, cost, per-model breakdown. */
export class UsagePanel {
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly usage: UsageService
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'polyagent.usage',
        t('usage.title'),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        }
      );
      this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
      this.panel.webview.html = this.html(this.panel.webview);
      const languageWatch = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('polyagent.language') && this.panel) {
          this.panel.title = t('usage.title');
          this.panel.webview.html = this.html(this.panel.webview);
        }
      });
      this.panel.onDidDispose(() => {
        languageWatch.dispose();
        this.panel = undefined;
        this.stopAutoRefresh();
      });
      this.panel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === 'refresh' || message?.type === 'ready') {
          await this.refresh();
        } else if (message?.type === 'setAdminKey') {
          await vscode.commands.executeCommand('polyagent.setAdminKey', message.providerId);
          await this.refresh();
        } else if (message?.type === 'openSettings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'polyagent.providers');
        }
      });
    }
    this.startAutoRefresh();
  }

  private async refresh(): Promise<void> {
    if (!this.panel) {
      return;
    }
    this.panel.webview.postMessage({ type: 'loading' });
    const reports = await this.usage.fetchAll();
    this.panel.webview.postMessage({ type: 'reports', reports });
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    const minutes = vscode.workspace
      .getConfiguration('polyagent')
      .get<number>('usage.autoRefreshMinutes', 0);
    if (minutes > 0) {
      this.timer = setInterval(() => void this.refresh(), minutes * 60_000);
    }
  }

  private stopAutoRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.panel?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const nonce = randomNonce();
    const lang = resolveLanguage();

    return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${asset('chat.css')}" />
<link rel="stylesheet" href="${asset('usage.css')}" />
<title>PolyMoly · ${t('usage.title')}</title>
</head>
<body class="usage-body" data-logo="${asset('icon.svg')}">
<div id="root"></div>
${webviewI18nScript(nonce)}
<script nonce="${nonce}" src="${asset('usage.js')}"></script>
</body>
</html>`;
  }
}

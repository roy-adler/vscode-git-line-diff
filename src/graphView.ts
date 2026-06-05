import * as vscode from 'vscode';
import type { GitApi } from './gitApi';
import { computeGraphLayout, type GraphLine } from './graphLayout';

/** Webview panel view type for the commit graph. */
export const GRAPH_VIEW_TYPE = 'gitLineDiffGraph';

/** Row data sent to the webview for rendering. */
interface GraphRowData {
  readonly hash: string;
  readonly short: string;
  readonly col: number;
  readonly color: number;
  readonly lines: GraphLine[];
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

/** Messages posted from the webview back to the extension. */
interface OpenCommitMessage {
  readonly type: 'openCommit';
  readonly hash: string;
}

function isOpenCommitMessage(value: unknown): value is OpenCommitMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === 'openCommit' && typeof record.hash === 'string';
}

/**
 * Manages a single commit-graph webview **panel** in the editor area (full
 * width, like Git Graph). Opened on demand via {@link show}; clicking a commit
 * opens its multi-file pretty diff via the supplied callback. Re-renders when
 * the repository changes while the panel is open.
 */
export class GitLineDiffGraphPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** Disposables tied to the controller's whole lifetime. */
  private readonly disposables: vscode.Disposable[] = [];
  /** Disposables tied to the currently-open panel. */
  private panelDisposables: vscode.Disposable[] = [];

  /**
   * @param gitApi Source of commit history.
   * @param onOpenCommit Invoked with a commit hash when the user clicks a row.
   * @param extensionUri Base URI of the extension, used to resolve the tab icon.
   * @param maxCommits Upper bound on commits to load.
   */
  constructor(
    private readonly gitApi: GitApi,
    private readonly onOpenCommit: (hash: string) => void,
    private readonly extensionUri: vscode.Uri,
    private readonly maxCommits = 200,
  ) {
    // Keep an open panel in sync with repository changes.
    this.disposables.push(
      this.gitApi.onDidChange(() => {
        if (this.panel !== undefined) {
          void this.render();
        }
      }),
    );
  }

  /** Opens the graph panel, or reveals it if already open. */
  public show(): void {
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      GRAPH_VIEW_TYPE,
      'GitLineDiff Graph',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'images',
      'icon.png',
    );
    this.panel = panel;

    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (isOpenCommitMessage(message)) {
          this.onOpenCommit(message.hash);
        }
      }),
      panel.onDidDispose(() => this.closePanel()),
    );

    void this.render();
  }

  /** Re-renders if the panel is open. */
  public refresh(): void {
    if (this.panel !== undefined) {
      void this.render();
    }
  }

  private async render(): Promise<void> {
    const panel = this.panel;
    if (panel === undefined) {
      return;
    }

    const commits = await this.gitApi.getRecentCommits(this.maxCommits);
    const layout = computeGraphLayout(commits);
    const rows: GraphRowData[] = layout.rows.map((row, index) => {
      const commit = commits[index];
      return {
        hash: row.hash,
        short: row.hash.slice(0, 7),
        col: row.col,
        color: row.color,
        lines: row.linesAbove,
        subject: firstLine(commit.message),
        author: commit.authorName ?? '',
        date: commit.authorDate ? formatDate(commit.authorDate) : '',
      };
    });

    panel.webview.html = renderHtml(panel.webview, rows, layout.columns);
  }

  private closePanel(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
    this.panel = undefined;
  }

  public dispose(): void {
    this.panel?.dispose();
    this.closePanel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Returns the first non-empty line of a commit message. */
function firstLine(message: string): string {
  const line = message.split('\n', 1)[0] ?? '';
  return line.trim();
}

/** Formats a date as a short, locale-independent `YYYY-MM-DD` string. */
function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Generates a random nonce for the Content Security Policy. */
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** Builds the full webview HTML document. */
function renderHtml(
  webview: vscode.Webview,
  rows: GraphRowData[],
  columns: number,
): string {
  const nonce = makeNonce();
  const data = JSON.stringify({ rows, columns });

  if (rows.length === 0) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';" />
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:12px;}</style>
</head><body><p>No commits to display.</p></body></html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  :root {
    --row-height: 28px;
    --col-width: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  #container { position: relative; }
  #graph {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
  }
  .row {
    display: flex;
    align-items: center;
    height: var(--row-height);
    padding-right: 8px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .subject {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    flex: 0 0 auto;
    margin-left: 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .hash {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    margin-left: 10px;
  }
</style>
</head>
<body>
<div id="container"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${data};
  const ROW_H = 28, COL_W = 14, PAD = 12, R = 4;
  // Distinct lane colours (independent of theme for clear branch separation).
  const PALETTE = ['#e8a33d','#4e94ce','#52b455','#c74e39','#9a7fd1','#3fb1b3','#d36ba6','#8aa650'];
  const colX = (c) => PAD + c * COL_W;
  const rowY = (i) => i * ROW_H + ROW_H / 2;

  const container = document.getElementById('container');
  const graphWidth = PAD + Math.max(1, DATA.columns) * COL_W;
  const totalHeight = DATA.rows.length * ROW_H;

  // Build the graph SVG.
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('id', 'graph');
  svg.setAttribute('width', String(graphWidth));
  svg.setAttribute('height', String(totalHeight));

  DATA.rows.forEach((row, i) => {
    // Lines connecting the previous row to this one.
    for (const line of row.lines) {
      const x1 = colX(line.fromCol), y1 = rowY(i - 1);
      const x2 = colX(line.toCol), y2 = rowY(i);
      const path = document.createElementNS(svgNs, 'path');
      const midY = (y1 + y2) / 2;
      // Smooth S-curve when changing columns, straight line otherwise.
      const d = x1 === x2
        ? 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2
        : 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ' ' + x2 + ' ' + midY + ' ' + x2 + ' ' + y2;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', PALETTE[line.color % PALETTE.length]);
      path.setAttribute('stroke-width', '2');
      svg.appendChild(path);
    }
  });

  // Draw nodes on top of the lines.
  DATA.rows.forEach((row, i) => {
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('cx', String(colX(row.col)));
    circle.setAttribute('cy', String(rowY(i)));
    circle.setAttribute('r', String(R));
    circle.setAttribute('fill', PALETTE[row.color % PALETTE.length]);
    circle.setAttribute('stroke', 'var(--vscode-editor-background)');
    circle.setAttribute('stroke-width', '1.5');
    svg.appendChild(circle);
  });

  container.appendChild(svg);

  // Build the commit rows (text), offset to the right of the graph.
  const list = document.createElement('div');
  list.style.marginLeft = graphWidth + 'px';
  for (const row of DATA.rows) {
    const div = document.createElement('div');
    div.className = 'row';
    div.title = row.hash;
    div.innerHTML =
      '<span class="subject"></span>' +
      '<span class="hash"></span>' +
      '<span class="meta author"></span>' +
      '<span class="meta date"></span>';
    div.querySelector('.subject').textContent = row.subject || '(no message)';
    div.querySelector('.hash').textContent = row.short;
    div.querySelector('.author').textContent = row.author;
    div.querySelector('.date').textContent = row.date;
    div.addEventListener('click', () => {
      vscode.postMessage({ type: 'openCommit', hash: row.hash });
    });
    list.appendChild(div);
  }
  container.appendChild(list);
</script>
</body>
</html>`;
}

import * as vscode from 'vscode';
import type { GitApi, RefLabel } from './gitApi';
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
  readonly refs: RefLabel[];
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

    const [commits, refsByCommit] = await Promise.all([
      this.gitApi.getRecentCommits(this.maxCommits),
      this.gitApi.getRefsByCommit(),
    ]);
    const layout = computeGraphLayout(commits);
    const rows: GraphRowData[] = layout.rows.map((row, index) => {
      const commit = commits[index];
      return {
        hash: row.hash,
        short: row.hash.slice(0, 8),
        col: row.col,
        color: row.color,
        lines: row.linesAbove,
        subject: firstLine(commit.message),
        author: commit.authorName ?? '',
        date: commit.authorDate ? formatDateTime(commit.authorDate) : '',
        refs: refsByCommit.get(row.hash) ?? [],
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

/** Formats a date like `5 Jun 2026 12:29` (locale-independent). */
function formatDateTime(date: Date): string {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
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
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    user-select: none;
  }
  #header {
    position: sticky;
    top: 0;
    z-index: 3;
    display: grid;
    height: 28px;
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    font-weight: 600;
  }
  .hcell {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0 8px;
    overflow: hidden;
    white-space: nowrap;
    cursor: grab;
  }
  .hcell.dragging { opacity: 0.5; }
  .hcell.drop-target { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
  .resizer {
    position: absolute;
    top: 0;
    right: 0;
    width: 7px;
    height: 100%;
    cursor: col-resize;
  }
  #body { position: relative; }
  #graphWrap {
    position: absolute;
    top: 0;
    left: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 1;
  }
  #rows { position: relative; z-index: 2; }
  .row {
    display: grid;
    align-items: center;
    height: 28px;
    cursor: pointer;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .cell {
    padding: 0 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .cell.graph { background: transparent; }
  .cell.commit {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
  }
  .cell.date, .cell.author { color: var(--vscode-descriptionForeground); }
  .badge {
    display: inline-block;
    font-size: 0.82em;
    line-height: 15px;
    height: 16px;
    padding: 0 6px;
    margin-right: 6px;
    border-radius: 9px;
    border: 1px solid transparent;
    vertical-align: middle;
  }
  .badge.head { background: rgba(78,148,206,0.18); border-color: #4e94ce; color: var(--vscode-foreground); }
  .badge.remote { background: rgba(154,127,209,0.18); border-color: #9a7fd1; color: var(--vscode-foreground); }
  .badge.tag { background: rgba(82,180,85,0.18); border-color: #52b455; color: var(--vscode-foreground); }
  .badge.current { background: #4e94ce; border-color: #4e94ce; color: #ffffff; font-weight: 600; }
  .subject { vertical-align: middle; }
</style>
</head>
<body>
<div id="header"></div>
<div id="body">
  <div id="graphWrap"><svg id="graph"></svg></div>
  <div id="rows"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${data};
  const ROW_H = 28, COL_W = 14, PAD = 12, R = 4;
  const PALETTE = ['#e8a33d','#4e94ce','#52b455','#c74e39','#9a7fd1','#3fb1b3','#d36ba6','#8aa650'];
  const colX = function (c) { return PAD + c * COL_W; };
  const rowY = function (i) { return i * ROW_H + ROW_H / 2; };

  const graphNatural = PAD + Math.max(1, DATA.columns) * COL_W + PAD;
  const totalHeight = DATA.rows.length * ROW_H;

  // Column definitions and their default widths.
  var COLS = {
    graph: { label: 'Graph', def: Math.min(420, Math.max(80, graphNatural)) },
    description: { label: 'Description', def: 480 },
    date: { label: 'Date', def: 170 },
    author: { label: 'Author', def: 150 },
    commit: { label: 'Commit', def: 96 }
  };
  var DEFAULT_ORDER = ['graph', 'description', 'date', 'author', 'commit'];

  // Restore persisted column order/widths (validated against current columns).
  var state = vscode.getState() || {};
  var order = Array.isArray(state.order) ? state.order.filter(function (id) { return COLS[id]; }) : [];
  for (var k = 0; k < DEFAULT_ORDER.length; k++) {
    if (order.indexOf(DEFAULT_ORDER[k]) === -1) { order.push(DEFAULT_ORDER[k]); }
  }
  var widths = {};
  for (var id in COLS) {
    var stored = state.widths && state.widths[id];
    widths[id] = (typeof stored === 'number' && stored >= 40) ? stored : COLS[id].def;
  }
  function saveState() { vscode.setState({ order: order, widths: widths }); }

  var header = document.getElementById('header');
  var rowsEl = document.getElementById('rows');
  var graphWrap = document.getElementById('graphWrap');
  var rowEls = [];

  // ---- Graph SVG (drawn once; independent of column layout) ----
  (function drawGraph() {
    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.getElementById('graph');
    svg.setAttribute('width', String(graphNatural));
    svg.setAttribute('height', String(totalHeight));
    DATA.rows.forEach(function (row, i) {
      for (var j = 0; j < row.lines.length; j++) {
        var line = row.lines[j];
        var x1 = colX(line.fromCol), y1 = rowY(i - 1);
        var x2 = colX(line.toCol), y2 = rowY(i);
        var midY = (y1 + y2) / 2;
        var d = x1 === x2
          ? 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2
          : 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ' ' + x2 + ' ' + midY + ' ' + x2 + ' ' + y2;
        var path = document.createElementNS(svgNs, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', PALETTE[line.color % PALETTE.length]);
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);
      }
    });
    DATA.rows.forEach(function (row, i) {
      var circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('cx', String(colX(row.col)));
      circle.setAttribute('cy', String(rowY(i)));
      circle.setAttribute('r', String(R));
      circle.setAttribute('fill', PALETTE[row.color % PALETTE.length]);
      circle.setAttribute('stroke', 'var(--vscode-editor-background)');
      circle.setAttribute('stroke-width', '1.5');
      svg.appendChild(circle);
    });
  })();

  // ---- Layout application (widths + graph overlay position) ----
  // Description is the flexible column (grows/shrinks with the window); the
  // others keep their fixed, resizable pixel widths.
  function template() {
    return order.map(function (id) {
      return id === 'description' ? 'minmax(120px, 1fr)' : (widths[id] + 'px');
    }).join(' ');
  }
  function applyLayout() {
    var tpl = template();
    header.style.gridTemplateColumns = tpl;
    for (var i = 0; i < rowEls.length; i++) { rowEls[i].style.gridTemplateColumns = tpl; }
    // Position the graph overlay over the actual Graph cell. Measuring the DOM
    // keeps it correct even with a flexible column or reordered columns.
    var gcell = header.querySelector('.hcell[data-id="graph"]');
    if (gcell) {
      graphWrap.style.left = gcell.offsetLeft + 'px';
      graphWrap.style.width = gcell.offsetWidth + 'px';
    }
    graphWrap.style.height = totalHeight + 'px';
  }
  // Re-measure the graph overlay when the window (panel) is resized so the
  // flexible Description column reflows correctly.
  window.addEventListener('resize', applyLayout);

  // ---- Cell content per column ----
  function fillCell(cell, id, row) {
    if (id === 'graph') { return; }
    if (id === 'description') {
      for (var i = 0; i < row.refs.length; i++) {
        var ref = row.refs[i];
        var badge = document.createElement('span');
        badge.className = 'badge ' + ref.kind + (ref.current ? ' current' : '');
        badge.textContent = (ref.current ? '\\u25CF ' : '') + ref.name;
        cell.appendChild(badge);
      }
      var subject = document.createElement('span');
      subject.className = 'subject';
      subject.textContent = row.subject || '(no message)';
      cell.appendChild(subject);
      return;
    }
    if (id === 'date') { cell.textContent = row.date; return; }
    if (id === 'author') { cell.textContent = row.author; return; }
    if (id === 'commit') { cell.textContent = row.short; return; }
  }

  // ---- Build header (with resize + drag-to-reorder) ----
  function buildHeader() {
    header.textContent = '';
    order.forEach(function (id) {
      var hc = document.createElement('div');
      hc.className = 'hcell';
      hc.dataset.id = id;
      hc.draggable = true;
      var label = document.createElement('span');
      label.textContent = COLS[id].label;
      hc.appendChild(label);

      // The flexible Description column has no resizer (it fills the slack);
      // every fixed column gets one.
      if (id !== 'description') {
        var resizer = document.createElement('div');
        resizer.className = 'resizer';
        resizer.addEventListener('mousedown', function (e) { startResize(e, id); });
        // Don't start a column drag when grabbing the resizer.
        resizer.addEventListener('dragstart', function (e) { e.preventDefault(); });
        hc.appendChild(resizer);
      }

      hc.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', id);
        hc.classList.add('dragging');
      });
      hc.addEventListener('dragend', function () {
        hc.classList.remove('dragging');
        clearDropTargets();
      });
      hc.addEventListener('dragover', function (e) { e.preventDefault(); hc.classList.add('drop-target'); });
      hc.addEventListener('dragleave', function () { hc.classList.remove('drop-target'); });
      hc.addEventListener('drop', function (e) {
        e.preventDefault();
        var dragged = e.dataTransfer.getData('text/plain');
        clearDropTargets();
        if (dragged && dragged !== id) { reorder(dragged, id); }
      });
      header.appendChild(hc);
    });
  }
  function clearDropTargets() {
    var els = header.querySelectorAll('.drop-target');
    for (var i = 0; i < els.length; i++) { els[i].classList.remove('drop-target'); }
  }

  // ---- Build rows ----
  function buildRows() {
    rowsEl.textContent = '';
    rowEls = [];
    DATA.rows.forEach(function (row) {
      var rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.title = row.hash;
      order.forEach(function (id) {
        var cell = document.createElement('div');
        cell.className = 'cell ' + id;
        fillCell(cell, id, row);
        rowEl.appendChild(cell);
      });
      rowEl.addEventListener('click', function () {
        vscode.postMessage({ type: 'openCommit', hash: row.hash });
      });
      rowsEl.appendChild(rowEl);
      rowEls.push(rowEl);
    });
  }

  function rebuild() { buildHeader(); buildRows(); applyLayout(); }

  // ---- Resize handling ----
  var resizing = null;
  function startResize(e, id) {
    e.preventDefault();
    resizing = { id: id, startX: e.clientX, startW: widths[id] };
  }
  document.addEventListener('mousemove', function (e) {
    if (!resizing) { return; }
    var delta = e.clientX - resizing.startX;
    widths[resizing.id] = Math.max(40, resizing.startW + delta);
    applyLayout();
  });
  document.addEventListener('mouseup', function () {
    if (resizing) { resizing = null; saveState(); }
  });

  // ---- Reorder handling ----
  function reorder(draggedId, targetId) {
    var from = order.indexOf(draggedId);
    if (from !== -1) { order.splice(from, 1); }
    var to = order.indexOf(targetId);
    order.splice(to, 0, draggedId);
    saveState();
    rebuild();
  }

  rebuild();
</script>
</body>
</html>`;
}

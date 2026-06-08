import * as vscode from 'vscode';
import type { GitApi, RefLabel, CommitDiff, CommitDiffFile } from './gitApi';
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

/** Toolbar state passed to the webview to initialise the filter controls. */
interface GraphControls {
  /** Branch names available in the dropdown (excludes the "all" sentinel). */
  readonly branches: string[];
  /** Currently selected filter: a branch name or {@link ALL_BRANCHES}. */
  readonly branchFilter: string;
  /** Whether remote-tracking branches are shown. */
  readonly showRemote: boolean;
}

/** Sentinel filter value meaning "show all branches". */
const ALL_BRANCHES = '__all__';

/** A changed file as sent to the webview's commit-detail panel. */
interface DetailFile {
  readonly path: string;
  readonly name: string;
  readonly dir: string;
}

/** Commit detail (metadata + changed files) sent to the webview on demand. */
interface CommitDetailPayload {
  readonly type: 'commitDetail';
  readonly hash: string;
  readonly short: string;
  readonly parents: string[];
  readonly author: string;
  readonly email: string;
  readonly date: string;
  readonly message: string;
  readonly files: DetailFile[];
}

/** Messages posted from the webview back to the extension. */
interface RequestCommitDetailMessage {
  readonly type: 'requestCommitDetail';
  readonly hash: string;
}

interface OpenFileMessage {
  readonly type: 'openFile';
  readonly hash: string;
  readonly index: number;
}

interface SetBranchMessage {
  readonly type: 'setBranch';
  readonly branch: string;
}

interface SetShowRemoteMessage {
  readonly type: 'setShowRemote';
  readonly value: boolean;
}

interface CheckoutRefMessage {
  readonly type: 'checkoutRef';
  readonly name: string;
  readonly kind: RefLabel['kind'];
  readonly current: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isRequestCommitDetailMessage(value: unknown): value is RequestCommitDetailMessage {
  const record = asRecord(value);
  return record?.type === 'requestCommitDetail' && typeof record.hash === 'string';
}

function isOpenFileMessage(value: unknown): value is OpenFileMessage {
  const record = asRecord(value);
  return record?.type === 'openFile'
    && typeof record.hash === 'string'
    && typeof record.index === 'number';
}

function isSetBranchMessage(value: unknown): value is SetBranchMessage {
  const record = asRecord(value);
  return record?.type === 'setBranch' && typeof record.branch === 'string';
}

function isSetShowRemoteMessage(value: unknown): value is SetShowRemoteMessage {
  const record = asRecord(value);
  return record?.type === 'setShowRemote' && typeof record.value === 'boolean';
}

function isCheckoutRefMessage(value: unknown): value is CheckoutRefMessage {
  const record = asRecord(value);
  return record?.type === 'checkoutRef'
    && typeof record.name === 'string'
    && (record.kind === 'head' || record.kind === 'remote' || record.kind === 'tag')
    && typeof record.current === 'boolean';
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

  /** Branch filter: a branch name, or {@link ALL_BRANCHES}. */
  private branchFilter: string = ALL_BRANCHES;
  /** Whether remote-tracking branches are included. */
  private showRemote = true;

  /** Cache of resolved commit diffs, keyed by commit hash, for file opening. */
  private readonly diffCache = new Map<string, CommitDiff>();

  /**
   * @param gitApi Source of commit history.
   * @param onOpenFile Invoked when the user clicks a changed file in a commit's
   *        detail panel; opens that file's pretty diff (parent vs commit).
   * @param extensionUri Base URI of the extension, used to resolve the tab icon.
   * @param maxCommits Upper bound on commits to load.
   */
  constructor(
    private readonly gitApi: GitApi,
    private readonly onOpenFile: (
      baseRef: string,
      commitRef: string,
      file: CommitDiffFile,
    ) => void,
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
        if (isRequestCommitDetailMessage(message)) {
          void this.sendCommitDetail(message.hash);
        } else if (isOpenFileMessage(message)) {
          void this.openFile(message.hash, message.index);
        } else if (isSetBranchMessage(message)) {
          this.branchFilter = message.branch;
          void this.render();
        } else if (isSetShowRemoteMessage(message)) {
          this.showRemote = message.value;
          void this.render();
        } else if (isCheckoutRefMessage(message)) {
          void this.checkoutRef(message);
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

    // Repository state may have changed; drop cached diffs so detail panels
    // re-fetch fresh data on next expand.
    this.diffCache.clear();

    const branchInfos = await this.gitApi.listBranches(this.showRemote);
    const branchNames = branchInfos.map((b) => b.name);

    // If the selected branch is no longer available (e.g. remotes were just
    // hidden), fall back to showing all branches.
    if (this.branchFilter !== ALL_BRANCHES && !branchNames.includes(this.branchFilter)) {
      this.branchFilter = ALL_BRANCHES;
    }

    // "Show all" logs from every visible branch tip; otherwise log the one
    // selected branch. An empty list falls back to HEAD inside the Git API.
    const refNames =
      this.branchFilter === ALL_BRANCHES ? branchNames : [this.branchFilter];

    const [commits, refsByCommit] = await Promise.all([
      this.gitApi.getRecentCommits(this.maxCommits, refNames),
      this.gitApi.getRefsByCommit(this.showRemote),
    ]);
    const controls: GraphControls = {
      branches: branchNames,
      branchFilter: this.branchFilter,
      showRemote: this.showRemote,
    };
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

    panel.webview.html = renderHtml(panel.webview, rows, layout.columns, controls);
  }

  /** Resolves a commit's diff once, caching it for later file opening. */
  private async resolveDiff(hash: string): Promise<CommitDiff> {
    const cached = this.diffCache.get(hash);
    if (cached !== undefined) {
      return cached;
    }
    const diff = await this.gitApi.getCommitDiff(hash);
    this.diffCache.set(hash, diff);
    return diff;
  }

  /** Fetches commit metadata + changed files and posts them to the webview. */
  private async sendCommitDetail(hash: string): Promise<void> {
    const panel = this.panel;
    if (panel === undefined) {
      return;
    }
    const [commit, diff] = await Promise.all([
      this.gitApi.getCommit(hash),
      this.resolveDiff(hash),
    ]);

    const files: DetailFile[] = diff.files.map((file) => {
      const path = file.relativePath;
      const slash = path.lastIndexOf('/');
      return {
        path,
        name: slash === -1 ? path : path.slice(slash + 1),
        dir: slash === -1 ? '' : path.slice(0, slash),
      };
    });

    const payload: CommitDetailPayload = {
      type: 'commitDetail',
      hash,
      short: hash.slice(0, 8),
      parents: commit?.parents ?? [],
      author: commit?.authorName ?? '',
      email: commit?.authorEmail ?? '',
      date: commit?.authorDate ? formatDateTime(commit.authorDate) : '',
      message: commit?.message?.trim() ?? '',
      files,
    };
    void panel.webview.postMessage(payload);
  }

  /** Checks out a branch badge double-clicked in the graph. */
  private async checkoutRef(message: CheckoutRefMessage): Promise<void> {
    const label: RefLabel = {
      name: message.name,
      kind: message.kind,
      current: message.current,
    };
    try {
      await this.gitApi.checkoutRef(label);
      if (!message.current) {
        void vscode.window.showInformationMessage(`GitLineDiff: checked out ${message.name}.`);
      }
      // Repository state change triggers onDidChange -> re-render with updated HEAD badge.
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`GitLineDiff: could not checkout ${message.name}. ${detail}`);
    }
  }

  /** Opens the pretty diff for the file at `index` within commit `hash`. */
  private async openFile(hash: string, index: number): Promise<void> {
    const diff = await this.resolveDiff(hash);
    const file = diff.files[index];
    if (file !== undefined) {
      this.onOpenFile(diff.baseRef, diff.commitRef, file);
    }
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
  controls: GraphControls,
): string {
  const nonce = makeNonce();
  const data = JSON.stringify({ rows, columns, controls });

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
  #toolbar {
    position: sticky;
    top: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 12px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    white-space: nowrap;
  }
  #toolbar .label { color: var(--vscode-descriptionForeground); }
  #toolbar select {
    height: 24px;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 3px;
    padding: 0 6px;
  }
  #toolbar label.check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .toolbar-spacer { flex: 1 1 auto; min-width: 8px; }
  #searchWrap {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 300px;
    flex: 0 1 300px;
  }
  #searchInput {
    flex: 1;
    min-width: 100px;
    height: 24px;
    padding: 0 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
  }
  #searchClear {
    display: none;
    width: 22px;
    height: 22px;
    padding: 0;
    line-height: 20px;
    text-align: center;
    color: var(--vscode-foreground);
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
  }
  #searchClear:hover { background: var(--vscode-toolbar-hoverBackground); }
  #searchCount {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    min-width: 4em;
  }
  .row.filtered-out, .detail.filtered-out { display: none !important; }
  #header {
    position: sticky;
    top: 36px;
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
  .badge.head, .badge.remote { cursor: pointer; }
  .badge.head { background: rgba(78,148,206,0.18); border-color: #4e94ce; color: var(--vscode-foreground); }
  .badge.remote { background: rgba(154,127,209,0.18); border-color: #9a7fd1; color: var(--vscode-foreground); }
  .badge.tag { background: rgba(82,180,85,0.18); border-color: #52b455; color: var(--vscode-foreground); }
  .badge.current { background: #4e94ce; border-color: #4e94ce; color: #ffffff; font-weight: 600; }
  .subject { vertical-align: middle; }
  .detail {
    display: none;
    position: relative;
    z-index: 2;
    /* Transparent background so the graph lanes (drawn behind) remain visible
       in the left gutter while a commit is expanded. */
    background: transparent;
  }
  .detail-inner {
    display: flex;
    align-items: stretch;
    gap: 0;
    /* Indent past the graph lane so lines stay visible on the left. */
    margin-left: 60px;
    min-height: 120px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  }
  .detail-meta {
    flex: 1 1 50%;
    min-width: 0;
    padding: 10px 14px;
    overflow: auto;
    border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  }
  .detail-files {
    flex: 1 1 50%;
    min-width: 0;
    padding: 6px 0;
    overflow: auto;
  }
  .detail-meta .k { color: var(--vscode-descriptionForeground); }
  .detail-meta .mono {
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
  }
  .detail-meta .line { margin-bottom: 4px; }
  .detail-meta .msg {
    margin-top: 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .detail-loading { padding: 12px 14px; color: var(--vscode-descriptionForeground); }
  .detail-files .files-head {
    padding: 2px 14px 6px;
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
  }
  .file-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 14px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .file-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item .fname { text-overflow: ellipsis; overflow: hidden; }
  .file-item .fdir {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  #empty, #noSearchResults {
    display: none;
    padding: 16px 12px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
<div id="toolbar">
  <span class="label">Branches:</span>
  <select id="branchSelect" title="Filter the graph by branch"></select>
  <label class="check"><input type="checkbox" id="remoteToggle" /> Show Remote Branches</label>
  <span class="toolbar-spacer"></span>
  <div id="searchWrap">
    <input type="search" id="searchInput" placeholder="Search commits\u2026" title="Search by message, author, hash, branch, or date (Ctrl+F / Cmd+F)" />
    <button type="button" id="searchClear" title="Clear search" aria-label="Clear search">\u00d7</button>
  </div>
  <span id="searchCount"></span>
</div>
<div id="header"></div>
<div id="body">
  <div id="graphWrap"><svg id="graph"></svg></div>
  <div id="rows"></div>
</div>
<div id="empty">No commits to display for the current filter.</div>
<div id="noSearchResults">No commits match your search.</div>
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
  var searchQuery = typeof state.search === 'string' ? state.search : '';
  function saveState() {
    vscode.setState({ order: order, widths: widths, search: searchQuery });
  }

  var header = document.getElementById('header');
  var rowsEl = document.getElementById('rows');
  var graphWrap = document.getElementById('graphWrap');
  var rowEls = [];
  var detailEls = [];

  // ---- Graph SVG ----
  // Node/line vertical positions are measured from the actual row elements, so
  // expanding a commit-detail panel (which pushes rows down) keeps the lanes
  // aligned and lets a lane continue straight through the expanded gap.
  function centerY(i) {
    var el = rowEls[i];
    return el ? el.offsetTop + ROW_H / 2 : rowY(i);
  }
  function isRowVisible(i) {
    return rowEls[i] && !rowEls[i].classList.contains('filtered-out');
  }
  function drawGraph() {
    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.getElementById('graph');
    while (svg.firstChild) { svg.removeChild(svg.firstChild); }
    var h = rowsEl.offsetHeight || totalHeight;
    svg.setAttribute('width', String(graphNatural));
    svg.setAttribute('height', String(h));
    graphWrap.style.height = h + 'px';
    DATA.rows.forEach(function (row, i) {
      if (!isRowVisible(i) || !isRowVisible(i - 1)) { return; }
      for (var j = 0; j < row.lines.length; j++) {
        var line = row.lines[j];
        var x1 = colX(line.fromCol), y1 = centerY(i - 1);
        var x2 = colX(line.toCol), y2 = centerY(i);
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
      if (!isRowVisible(i)) { return; }
      var circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('cx', String(colX(row.col)));
      circle.setAttribute('cy', String(centerY(i)));
      circle.setAttribute('r', String(R));
      circle.setAttribute('fill', PALETTE[row.color % PALETTE.length]);
      circle.setAttribute('stroke', 'var(--vscode-editor-background)');
      circle.setAttribute('stroke-width', '1.5');
      svg.appendChild(circle);
    });
  }

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
    graphWrap.style.height = (rowsEl.offsetHeight || totalHeight) + 'px';
  }
  // Re-measure the graph overlay when the window (panel) is resized so the
  // flexible Description column reflows correctly. Also redraw the graph so its
  // height stays correct when a detail panel is expanded.
  window.addEventListener('resize', function () {
    applyLayout();
    if (typeof drawGraph === 'function') { drawGraph(); }
  });

  // ---- Cell content per column ----
  function fillCell(cell, id, row) {
    if (id === 'graph') { return; }
    if (id === 'description') {
      for (var i = 0; i < row.refs.length; i++) {
        var ref = row.refs[i];
        var badge = document.createElement('span');
        badge.className = 'badge ' + ref.kind + (ref.current ? ' current' : '');
        badge.textContent = (ref.current ? '\\u25CF ' : '') + ref.name;
        if (ref.kind === 'head' || ref.kind === 'remote') {
          (function (r) {
            badge.title = r.current
              ? 'Currently checked out'
              : 'Double-click to checkout ' + r.name;
            badge.addEventListener('click', function (e) { e.stopPropagation(); });
            badge.addEventListener('dblclick', function (e) {
              e.stopPropagation();
              e.preventDefault();
              vscode.postMessage({
                type: 'checkoutRef',
                name: r.name,
                kind: r.kind,
                current: !!r.current
              });
            });
          })(ref);
        }
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

  // ---- Build rows (each commit row is followed by a hidden detail panel) ----
  var hashToIndex = {};
  var openIndex = -1;
  function buildRows() {
    rowsEl.textContent = '';
    rowEls = [];
    detailEls = [];
    hashToIndex = {};
    openIndex = -1;
    DATA.rows.forEach(function (row, i) {
      hashToIndex[row.hash] = i;
      var rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.title = row.hash;
      order.forEach(function (id) {
        var cell = document.createElement('div');
        cell.className = 'cell ' + id;
        fillCell(cell, id, row);
        rowEl.appendChild(cell);
      });
      rowEl.addEventListener('click', function () { toggleDetail(i, row); });
      rowsEl.appendChild(rowEl);
      rowEls.push(rowEl);

      var detail = document.createElement('div');
      detail.className = 'detail';
      rowsEl.appendChild(detail);
      detailEls.push(detail);
    });
  }

  // ---- Commit detail panel ----
  function toggleDetail(i, row) {
    var d = detailEls[i];
    if (d.style.display === 'block') {
      d.style.display = 'none';
      openIndex = -1;
      drawGraph();
      return;
    }
    if (openIndex !== -1 && detailEls[openIndex]) {
      detailEls[openIndex].style.display = 'none';
    }
    openIndex = i;
    d.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'detail-loading';
    loading.textContent = 'Loading changes\\u2026';
    d.appendChild(loading);
    d.style.display = 'block';
    drawGraph();
    vscode.postMessage({ type: 'requestCommitDetail', hash: row.hash });
  }

  function metaLine(key, valueNode) {
    var line = document.createElement('div');
    line.className = 'line';
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = key + ' ';
    line.appendChild(k);
    line.appendChild(valueNode);
    return line;
  }
  function textSpan(text, cls) {
    var s = document.createElement('span');
    if (cls) { s.className = cls; }
    s.textContent = text;
    return s;
  }

  function renderDetail(detail) {
    var i = hashToIndex[detail.hash];
    if (i === undefined) { return; }
    var d = detailEls[i];
    d.textContent = '';

    var inner = document.createElement('div');
    inner.className = 'detail-inner';

    // Left: metadata.
    var meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.appendChild(metaLine('Commit:', textSpan(detail.hash, 'mono')));
    if (detail.parents.length) {
      meta.appendChild(metaLine('Parents:', textSpan(detail.parents.join(', '), 'mono')));
    }
    var who = detail.author + (detail.email ? ' <' + detail.email + '>' : '');
    if (who.trim()) { meta.appendChild(metaLine('Author:', textSpan(who))); }
    if (detail.date) { meta.appendChild(metaLine('Date:', textSpan(detail.date))); }
    if (detail.message) {
      var msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = detail.message;
      meta.appendChild(msg);
    }
    inner.appendChild(meta);

    // Right: changed files.
    var filesWrap = document.createElement('div');
    filesWrap.className = 'detail-files';
    var head = document.createElement('div');
    head.className = 'files-head';
    head.textContent = detail.files.length + (detail.files.length === 1 ? ' file changed' : ' files changed');
    filesWrap.appendChild(head);
    detail.files.forEach(function (file, index) {
      var item = document.createElement('div');
      item.className = 'file-item';
      item.title = file.path;
      item.appendChild(textSpan(file.name, 'fname'));
      if (file.dir) { item.appendChild(textSpan(file.dir, 'fdir')); }
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'openFile', hash: detail.hash, index: index });
      });
      filesWrap.appendChild(item);
    });
    if (detail.files.length === 0) {
      filesWrap.appendChild(textSpan('No file changes.', 'detail-loading'));
    }
    inner.appendChild(filesWrap);

    d.appendChild(inner);
    drawGraph();
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg && msg.type === 'commitDetail') { renderDetail(msg); }
  });

  // ---- Search ----
  function rowMatches(row, q) {
    var needle = q.toLowerCase();
    if ((row.subject || '').toLowerCase().indexOf(needle) !== -1) { return true; }
    if ((row.author || '').toLowerCase().indexOf(needle) !== -1) { return true; }
    if ((row.date || '').toLowerCase().indexOf(needle) !== -1) { return true; }
    if ((row.hash || '').toLowerCase().indexOf(needle) !== -1) { return true; }
    if ((row.short || '').toLowerCase().indexOf(needle) !== -1) { return true; }
    for (var r = 0; r < row.refs.length; r++) {
      if ((row.refs[r].name || '').toLowerCase().indexOf(needle) !== -1) { return true; }
    }
    return false;
  }
  function applySearch() {
    var q = searchQuery.trim();
    var active = q.length > 0;
    var visible = 0;
    for (var i = 0; i < DATA.rows.length; i++) {
      var match = !active || rowMatches(DATA.rows[i], q);
      if (match) { visible++; }
      rowEls[i].classList.toggle('filtered-out', !match);
      if (!match) {
        detailEls[i].classList.add('filtered-out');
        detailEls[i].style.display = 'none';
        if (openIndex === i) { openIndex = -1; }
      } else {
        detailEls[i].classList.remove('filtered-out');
      }
    }
    var countEl = document.getElementById('searchCount');
    if (countEl) {
      countEl.textContent = active ? (visible + ' / ' + DATA.rows.length) : '';
    }
    var clearBtn = document.getElementById('searchClear');
    if (clearBtn) {
      clearBtn.style.display = active ? 'inline-block' : 'none';
    }
    var noResults = document.getElementById('noSearchResults');
    var body = document.getElementById('body');
    var hdr = document.getElementById('header');
    if (active && visible === 0) {
      if (noResults) { noResults.style.display = 'block'; }
      if (body) { body.style.display = 'none'; }
      if (hdr) { hdr.style.display = 'none'; }
    } else {
      if (noResults) { noResults.style.display = 'none'; }
      if (body) { body.style.display = ''; }
      if (hdr) { hdr.style.display = ''; }
    }
    drawGraph();
  }

  function rebuild() {
    buildHeader();
    buildRows();
    applyLayout();
    applySearch();
  }

  // ---- Toolbar: branch filter + remote toggle + search ----
  (function buildToolbar() {
    var ctrl = DATA.controls || { branches: [], branchFilter: '__all__', showRemote: true };
    var select = document.getElementById('branchSelect');
    var allOpt = document.createElement('option');
    allOpt.value = '__all__';
    allOpt.textContent = 'Show All';
    select.appendChild(allOpt);
    for (var i = 0; i < ctrl.branches.length; i++) {
      var opt = document.createElement('option');
      opt.value = ctrl.branches[i];
      opt.textContent = ctrl.branches[i];
      select.appendChild(opt);
    }
    select.value = ctrl.branchFilter;
    select.addEventListener('change', function () {
      vscode.postMessage({ type: 'setBranch', branch: select.value });
    });

    var toggle = document.getElementById('remoteToggle');
    toggle.checked = !!ctrl.showRemote;
    toggle.addEventListener('change', function () {
      vscode.postMessage({ type: 'setShowRemote', value: toggle.checked });
    });

    var searchInput = document.getElementById('searchInput');
    searchInput.value = searchQuery;
    searchInput.addEventListener('input', function () {
      searchQuery = searchInput.value;
      applySearch();
      saveState();
    });
    document.getElementById('searchClear').addEventListener('click', function () {
      searchQuery = '';
      searchInput.value = '';
      applySearch();
      saveState();
      searchInput.focus();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      if (e.key === 'Escape' && document.activeElement === searchInput && searchQuery) {
        searchQuery = '';
        searchInput.value = '';
        applySearch();
        saveState();
      }
    });
  })();

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

  if (DATA.rows.length === 0) {
    // Keep the toolbar usable so the user can widen the filter again.
    document.getElementById('header').style.display = 'none';
    document.getElementById('body').style.display = 'none';
    document.getElementById('empty').style.display = 'block';
  } else {
    rebuild();
  }
</script>
</body>
</html>`;
}

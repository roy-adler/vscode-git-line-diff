# GitLineDiff

A Visual Studio Code extension that makes **single-line files diffable**.

Many repositories store data files — especially JSON — as a single, minified
line. Git diffs of those files are nearly useless: any change marks the *entire*
line as modified, so you can't see *what* actually changed.

GitLineDiff adds a custom **Source Control** view that lets you open a diff in
which **both sides are pretty-printed in memory** before being compared. The
files on disk are **never modified** — all transformations happen in virtual
documents.

![Source Control view](https://raw.githubusercontent.com/_/_/main/.github/preview.png)

---

## Features

- **Custom Source Control view** (`GitLineDiff`) listing changed files.
- **JSON pretty-printing** out of the box (`JSON.stringify(JSON.parse(x), null, 2)`).
- **Embedded-JSON expansion** — pretty-prints single-line JSON stored *inside*
  another file, such as a YAML value `attributeValue: '{"a":1,...}'`.
- **Configurable** — control file types, and which keys/patterns to expand,
  through VS Code settings (see [Configuration](#configuration)).
- **In-memory only** — uses VS Code virtual documents; originals are untouched.
- **Extensible formatter registry** — add XML, YAML, TOML, or custom formats
  with a few lines of code.
- **Right-click anywhere** — "Open Changes with GitLineDiff" from the Source
  Control changes list, the Explorer, or an editor tab (HEAD vs working tree).
- **Commit graph** — a full-width visual history graph that opens in the editor
  area (via a status-bar button or the view toolbar); click a commit to expand
  its details and changed files, then open any file as a pretty diff.
- **Auto-refresh** — the views and open diffs update when the repo *or* the
  settings change.

The view lists **all** changed files in the working tree. Files with a matching
formatter are annotated (e.g. `config.yaml · embedded-json`) and open as a
pretty diff; files without one open as an ordinary diff.

### Ways to open a pretty diff

- **GitLineDiff view** — click a changed file (working tree vs `HEAD`).
- **Right-click → "Open Changes with GitLineDiff"** — from the built-in Source
  Control changes list, the Explorer, or the editor tab context menu.
- **Commit graph** — open it with the **GitLineDiff Graph** status-bar button,
  the graph icon in the GitLineDiff view toolbar, or **"GitLineDiff: Open Commit
  Graph"** from the Command Palette. Click any commit to expand an inline detail
  panel (commit metadata + changed files), then click a file to open its pretty
  diff vs the parent revision. (You can also run **"GitLineDiff: Open Commit
  Diff"** to pick a commit from a list and open all its files at once.)

### The commit graph

The graph opens as a **full-width panel in the editor area** (like Git Graph),
rendering your commit history with branch/merge lanes. It's our own webview —
not VS Code's built-in graph — because the built-in graph's context menu is
gated behind a proposed API that installed extensions can't use. Owning the
panel lets us put the pretty diff one click away from any commit. Diffs are
commit-vs-first-parent (the root commit is compared against the empty tree).

The panel is laid out as a table with **resizable and reorderable columns**:

| Column | Contents |
| --- | --- |
| **Graph** | Branch/merge lanes with a node per commit. |
| **Description** | Branch/remote/tag badges (current branch highlighted) + commit subject. |
| **Date** | Author date and time. |
| **Author** | Author name. |
| **Commit** | Short commit hash. |

Drag a column's right edge to **resize** it, or drag a column header onto
another to **reorder** columns. Your layout is remembered across sessions.

A toolbar above the table gives you a **full git view**:

- **Branches** dropdown — choose **Show All** to see every branch's history in a
  single unified graph, or pick one branch to focus on just its commits.
- **Show Remote Branches** — toggle whether remote-tracking branches appear in
  both the graph (as badges and history) and the Branches dropdown.
- **Double-click a branch badge** — check out that branch (local branches
  directly; remote-tracking branches check out an existing local branch or create
  one tracking the remote).

> **Works in Cursor too.** Cursor is a fork of VS Code and ships the same
> built-in Git extension (`vscode.git`) and extension API, so GitLineDiff runs
> there unchanged — press <kbd>F5</kbd> to debug or install the `.vsix`
> directly. The only difference is publishing: Cursor uses the Open VSX
> registry rather than the Microsoft Marketplace.

---

## Installation

### From source (recommended during development)

```bash
git clone <this-repo>
cd vscode-git-line-diff
npm install
npm run compile
```

Then press <kbd>F5</kbd> in VS Code to launch an **Extension Development Host**
with GitLineDiff loaded.

### Packaging a `.vsix`

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension gitlinediff-0.1.0.vsix
# In Cursor:
cursor --install-extension gitlinediff-0.1.0.vsix
```

---

## Development setup

| Command | Description |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run compile` | Type-check and build to `out/`. |
| `npm run watch` | Rebuild on change. |
| `npm run lint` | Run ESLint over `src/`. |
| <kbd>F5</kbd> | Launch the Extension Development Host. |

Requirements: Node.js 18+, VS Code 1.85+. The built-in Git extension
(`vscode.git`) must be enabled — it is declared as an extension dependency.

---

## Configuration

All settings live under the `gitlinediff.*` namespace and update the view and
any open diffs live.

| Setting | Default | Description |
| --- | --- | --- |
| `gitlinediff.json.fileExtensions` | `["json"]` | Extensions treated as standalone JSON and pretty-printed. |
| `gitlinediff.embeddedJson.enabled` | `true` | Expand single-line JSON strings embedded inside other files. |
| `gitlinediff.embeddedJson.fileExtensions` | `["yaml", "yml"]` | Extensions scanned for embedded JSON values. |
| `gitlinediff.embeddedJson.autoDetect` | `true` | When no `keys`/`keyPattern` are set, expand any value that parses as a JSON object/array. |
| `gitlinediff.embeddedJson.keys` | `[]` | Restrict expansion to these exact key names. |
| `gitlinediff.embeddedJson.keyPattern` | `""` | Optional regex matched against key names. |

**Eligibility rule for embedded JSON:** a value is expanded only if it parses as
a JSON object/array **and** its key is eligible. A key is eligible if `keys`
contains it or `keyPattern` matches it; if neither is configured, `autoDetect`
makes every key eligible.

### Example

Given this YAML in the working tree (a real, single-line value):

```yaml
metadata:
  name: demo
  attributeValue: '{"a":1,"b":{"c":2},"d":[1,2]}'
```

GitLineDiff renders the diff side as:

```yaml
metadata:
  name: demo
  attributeValue: |-
    {
      "a": 1,
      "b": {
        "c": 2
      },
      "d": [
        1,
        2
      ]
    }
```

Only the matched value line is rewritten (as a YAML block scalar); every other
line is preserved exactly, so the diff stays focused on what actually changed.
To expand only specific keys, set:

```jsonc
"gitlinediff.embeddedJson.keys": ["attributeValue"]
```

## How it works

1. **Git integration** (`src/gitApi.ts`)
   Acquires the built-in Git extension API (`vscode.git`, version `1`), lists
   working-tree changes, and reads file content from both the working tree and
   `HEAD` (via `Repository.show('HEAD', path)`).

2. **Source Control view** (`src/treeView.ts`)
   A `TreeDataProvider` populates the `gitLineDiffView` view with the working
   tree's changed files, annotating each with the formatter that applies (if
   any). Selecting an item runs the `gitlinediff.openDiff` command.

3. **Virtual documents** (`src/extension.ts`)
   A `TextDocumentContentProvider` registered for the custom `gitlinediff`
   scheme produces pretty-printed content **on demand and in memory**. Each
   virtual URI encodes the original file path and which revision it represents
   (`head` or `working`):

   ```
   gitlinediff:/abs/path/to/file.json?ref=head&src=/abs/path/to/file.json
   ```

   Keeping the original path as the URI path means VS Code infers the correct
   language for syntax highlighting.

4. **Diff command** (`gitlinediff.openDiff`)
   Builds two virtual URIs (`HEAD` on the left, working tree on the right) and
   opens them with:

   ```ts
   vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `GitLineDiff: ${fileName}`);
   ```

   Both sides are transformed through the formatter registry first, so the diff
   compares readable, multi-line representations.

---

## Architecture overview

```
src/
├── extension.ts          Activation, virtual-document provider, commands, config wiring
├── config.ts             Typed reader for gitlinediff.* settings
├── gitApi.ts             Typed wrapper around the built-in Git extension (changes, refs, commits)
├── git.d.ts              Vendored, minimal type declarations for vscode.git
├── treeView.ts           Source Control TreeDataProvider + formatter annotation
├── graphLayout.ts        Pure commit-graph lane/line layout algorithm
├── graphView.ts          Commit-graph webview panel (renders the layout, opens commit diffs)
└── formatterRegistry.ts  Pluggable formatters (JSON + embedded-JSON), built from config
```

### Ref-aware virtual documents

A virtual URI encodes the file path plus a *ref*: `working` (read from disk) or
any git ref (`HEAD`, a commit hash, a parent). This single mechanism powers both
the working-tree diff (`HEAD` vs `working`) and commit diffs
(`parent` vs `commit`) — and a commit's multi-file diff is opened via
`_workbench.openMultiDiffEditor`, falling back to individual diff tabs if that
command is unavailable.

Design principles:

- **Separation of concerns** — Git access, UI, and content transformation are
  independent modules.
- **Strict typing** — strict TypeScript, no `any`; the Git API is fully typed.
- **Read-only & non-destructive** — transformations live only in virtual docs.
- **Extensible** — formats are added through a registry, not by editing core
  logic.

---

## Adding a formatter

Formatters are pure functions that turn raw content into a pretty-printed
string, falling back to the original content on failure. Register them in
`createDefaultRegistry()` (in `src/formatterRegistry.ts`) or anywhere you have
the registry instance.

### XML

```ts
registry.register({
  id: 'xml',
  extensions: ['xml', 'svg'],
  format: (content) => prettifyXml(content), // your formatter of choice
});
```

### YAML

```ts
import * as yaml from 'yaml';

registry.register({
  id: 'yaml',
  extensions: ['yaml', 'yml'],
  format: (content) => {
    try {
      return yaml.stringify(yaml.parse(content));
    } catch {
      return content; // never throw — fall back to raw content
    }
  },
});
```

### TOML

```ts
import * as toml from '@iarna/toml';

registry.register({
  id: 'toml',
  extensions: ['toml'],
  format: (content) => {
    try {
      return toml.stringify(toml.parse(content));
    } catch {
      return content;
    }
  },
});
```

To also show the new file type in the view, widen the filter in
`src/treeView.ts` (replace `jsonOnlyFilter`), e.g.:

```ts
const allowed = new Set(['json', 'xml', 'yaml', 'yml', 'toml']);
export const supportedFilter: FileFilter = (file) =>
  allowed.has(file.fileName.split('.').pop()?.toLowerCase() ?? '');
```

---

## License

MIT

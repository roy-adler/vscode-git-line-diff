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
- **In-memory only** — uses VS Code virtual documents; originals are untouched.
- **Extensible formatter registry** — add XML, YAML, TOML, or custom formats
  with a few lines of code.
- **Auto-refresh** — the view and any open diffs update when the repo changes.

Initially the view shows only `*.json` files (the formats most commonly stored
on a single line). See [Adding a formatter](#adding-a-formatter) to widen this.

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

## How it works

1. **Git integration** (`src/gitApi.ts`)
   Acquires the built-in Git extension API (`vscode.git`, version `1`), lists
   working-tree changes, and reads file content from both the working tree and
   `HEAD` (via `Repository.show('HEAD', path)`).

2. **Source Control view** (`src/treeView.ts`)
   A `TreeDataProvider` populates the `gitLineDiffView` view with changed files
   that pass a filter (JSON only by default). Selecting an item runs the
   `gitlinediff.openDiff` command.

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
├── extension.ts          Activation, virtual-document provider, commands
├── gitApi.ts             Typed wrapper around the built-in Git extension
├── git.d.ts              Vendored, minimal type declarations for vscode.git
├── treeView.ts           Source Control TreeDataProvider + file filter
└── formatterRegistry.ts  Pluggable content formatters (JSON built in)
```

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

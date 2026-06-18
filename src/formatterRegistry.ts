/**
 * Formatter registry.
 *
 * A `Formatter` takes raw file content and returns a human-readable,
 * "pretty-printed" representation. The whole point of the extension is to make
 * single-line files (such as minified JSON) diffable, so formatters expand
 * compact content into multi-line, readable output.
 *
 * Formatters are intentionally pure and side-effect free: they receive a
 * string and return a string. They must NEVER throw on malformed input —
 * instead they should fall back to returning the original content unchanged so
 * that the diff still works (just without prettification).
 */

import {
  formatOriginBadge,
  formatStructuredDocument,
  tryExpandJson,
  tryExpandYaml,
} from './structuredData';

/**
 * Transforms raw file content into a pretty-printed representation.
 *
 * @param content Raw file content.
 * @returns Pretty-printed content, or the original content if it cannot be
 *          transformed.
 */
export type FormatterFn = (content: string) => string;

export interface Formatter {
  /** Stable identifier, e.g. `"json"`. */
  readonly id: string;
  /**
   * Lower-cased file extensions this formatter handles, without the leading
   * dot (e.g. `["json"]`).
   */
  readonly extensions: readonly string[];
  /** The transformation function. */
  readonly format: FormatterFn;
}

/**
 * Holds the set of available formatters and resolves the correct one for a
 * given file. Adding support for a new format (XML, YAML, TOML, ...) is a
 * matter of constructing a `Formatter` and calling {@link register}.
 */
export class FormatterRegistry {
  /** Maps a lower-cased extension to its formatter. */
  private readonly byExtension = new Map<string, Formatter>();

  /**
   * Registers a formatter for all of its declared extensions. If two
   * formatters claim the same extension, the most recently registered one
   * wins.
   */
  public register(formatter: Formatter): void {
    for (const extension of formatter.extensions) {
      this.byExtension.set(extension.toLowerCase(), formatter);
    }
  }

  /**
   * Resolves the formatter for a given file path based on its extension.
   *
   * @param filePath Path or file name (only the extension is inspected).
   * @returns The matching formatter, or `undefined` if none is registered.
   */
  public resolve(filePath: string): Formatter | undefined {
    const extension = FormatterRegistry.extractExtension(filePath);
    if (extension === undefined) {
      return undefined;
    }
    return this.byExtension.get(extension);
  }

  /**
   * Applies the appropriate formatter to `content`. If no formatter matches,
   * the original content is returned unchanged.
   */
  public format(filePath: string, content: string): string {
    const formatter = this.resolve(filePath);
    if (formatter === undefined) {
      return content;
    }
    return formatter.format(content);
  }

  /** Returns the lower-cased extension (without the dot) or `undefined`. */
  private static extractExtension(filePath: string): string | undefined {
    // Normalise separators so this works on both POSIX and Windows paths.
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const dotIndex = fileName.lastIndexOf('.');
    // No dot, or a leading dot (dotfile such as ".gitignore") => no extension.
    if (dotIndex <= 0) {
      return undefined;
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
  }
}

/** Options for standalone JSON structured-data formatting. */
export interface StructuredJsonOptions {
  readonly extensions: readonly string[];
  /** When true, JSON is re-serialised canonically (pretty, sorted keys off). */
  readonly canonicalizeToJson: boolean;
}

/**
 * Creates a JSON formatter that re-serialises minified/single-line JSON with
 * two-space indentation and an origin badge. Falls back to the original content
 * on parse failure so that partial or non-standard JSON still diffs.
 */
export function createJsonFormatter(options: StructuredJsonOptions): Formatter {
  return {
    id: 'json',
    extensions: options.extensions,
    format: (content: string): string => {
      return (
        formatStructuredDocument(content, 'json', options.canonicalizeToJson) ??
        content
      );
    },
  };
}

/** Options for standalone YAML structured-data formatting. */
export interface StructuredYamlOptions {
  readonly extensions: readonly string[];
  readonly canonicalizeToJson: boolean;
  /** When set, embedded structured values are expanded before pretty-printing. */
  readonly embeddedJson: EmbeddedJsonOptions | undefined;
}

/**
 * Creates a YAML formatter that pretty-prints YAML documents (including
 * minified single-line YAML), optionally expands embedded JSON/YAML values,
 * prepends an origin badge, and can canonicalise to JSON for cross-format
 * comparison with `.json` files.
 */
export function createYamlFormatter(options: StructuredYamlOptions): Formatter {
  return {
    id: 'yaml',
    extensions: options.extensions,
    format: (content: string): string => {
      let working = content;
      let didEmbed = false;
      if (options.embeddedJson !== undefined) {
        const expanded = expandEmbeddedStructuredValues(content, options.embeddedJson);
        didEmbed = expanded !== content;
        working = expanded;
      }

      const formatted = formatStructuredDocument(
        working,
        'yaml',
        options.canonicalizeToJson,
      );
      if (formatted !== undefined) {
        return formatted;
      }
      if (didEmbed) {
        return formatOriginBadge('yaml') + working;
      }
      return content;
    },
  };
}

/** Options controlling which embedded JSON string values get expanded. */
export interface EmbeddedJsonOptions {
  readonly extensions: readonly string[];
  /** Expand any eligible key when no explicit keys/pattern are configured. */
  readonly autoDetect: boolean;
  /** Exact key names to expand. */
  readonly keys: readonly string[];
  /** Optional regex (string form) matched against key names. */
  readonly keyPattern: string;
}

/**
 * Matches a single YAML mapping entry whose value is a quoted scalar, e.g.
 *   `  attributeValue: '{"a":1}'`
 *   `  attributeValue:'{"a":1}'`   (no space after the colon — some generators)
 *   `- attributeValue: "{\"a\":1}"`
 * The space after the colon is optional (`\s*`) to support generators that omit
 * it. Captures: (1) indentation, (2) key, (3) quote char, (4) raw inner value.
 */
const QUOTED_ENTRY = /^(\s*)(?:-\s+)?(["']?)([^:"']+)\2:\s*(['"])(.*)\4\s*$/;

/** Matches the header line of a YAML block scalar (`|`, `|-`, `>`, …). */
const BLOCK_SCALAR_HEADER =
  /^(\s*)(?:-\s+)?(["']?)([^:"']+)\2:\s*([|>][+-]?)\s*$/;

/**
 * Decides whether a key is eligible for embedded-JSON expansion based on the
 * configured options. Mirrors the spec: explicit `keys`/`keyPattern` restrict
 * eligibility; otherwise `autoDetect` makes every key eligible.
 */
function isKeyEligible(key: string, options: EmbeddedJsonOptions): boolean {
  const hasKeyList = options.keys.length > 0;
  const hasPattern = options.keyPattern.length > 0;

  if (hasKeyList || hasPattern) {
    if (hasKeyList && options.keys.includes(key)) {
      return true;
    }
    if (hasPattern) {
      try {
        return new RegExp(options.keyPattern).test(key);
      } catch {
        // Invalid user regex — treat as non-matching rather than throwing.
        return false;
      }
    }
    return false;
  }

  return options.autoDetect;
}

/**
 * Unescapes the raw inner text of a quoted YAML scalar into the literal string
 * it represents, so it can be fed to `JSON.parse`.
 *
 * - Single-quoted YAML escapes a quote by doubling it (`''` -> `'`).
 * - Double-quoted YAML uses JSON-style backslash escapes, so re-wrapping the
 *   token and running it through `JSON.parse` yields the literal value.
 */
function unescapeYamlScalar(quote: string, inner: string): string {
  if (quote === "'") {
    return inner.replace(/''/g, "'");
  }
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return inner;
  }
}

/**
 * Expands embedded JSON strings and YAML block scalars inside a YAML file.
 * Expanded values are rendered as indented block scalars so the surrounding
 * YAML structure stays valid in the read-only diff view.
 */
function expandEmbeddedStructuredValues(
  content: string,
  options: EmbeddedJsonOptions,
): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const blockMatch = BLOCK_SCALAR_HEADER.exec(line);
    if (blockMatch !== null) {
      const [, indent, , key] = blockMatch;
      if (isKeyEligible(key, options)) {
        const parentIndentLen = indent.length;
        i++;
        const blockLines: string[] = [];
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim() === '') {
            blockLines.push(bodyLine);
            i++;
            continue;
          }
          const bodyIndent = bodyLine.match(/^(\s*)/)?.[1].length ?? 0;
          if (bodyIndent <= parentIndentLen) {
            break;
          }
          blockLines.push(bodyLine);
          i++;
        }

        const nonEmpty = blockLines.filter((l) => l.trim() !== '');
        if (nonEmpty.length > 0) {
          const minIndent = Math.min(
            ...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0),
          );
          const blockContent = nonEmpty.map((l) => l.slice(minIndent)).join('\n');
          const expanded =
            tryExpandYaml(blockContent) ?? tryExpandJson(blockContent.trim());
          if (expanded !== undefined) {
            const blockIndent = `${indent}  `;
            out.push(`${indent}${key}: |-`);
            for (const expandedLine of expanded.split('\n')) {
              out.push(`${blockIndent}${expandedLine}`);
            }
            continue;
          }
        }

        out.push(line);
        out.push(...blockLines);
        continue;
      }
    }

    const match = QUOTED_ENTRY.exec(line);
    if (match !== null) {
      const [, indent, , key, quote, rawValue] = match;
      if (isKeyEligible(key, options)) {
        const literal = unescapeYamlScalar(quote, rawValue);
        const expanded =
          tryExpandJson(literal) ?? tryExpandYaml(literal);
        if (expanded !== undefined) {
          const blockIndent = `${indent}  `;
          out.push(`${indent}${key}: |-`);
          for (const jsonLine of expanded.split('\n')) {
            out.push(`${blockIndent}${jsonLine}`);
          }
          i++;
          continue;
        }
      }
    }

    out.push(line);
    i++;
  }

  return out.join('\n');
}

/**
 * Creates a formatter that expands single-line JSON strings embedded as values
 * inside text files (typically YAML). The transformation is surgical: only
 * matched value lines are rewritten as indented YAML block scalars; every other
 * line is preserved byte-for-byte so diffs stay minimal.
 */
export function createEmbeddedJsonFormatter(options: EmbeddedJsonOptions): Formatter {
  return {
    id: 'embedded-json',
    extensions: options.extensions,
    format: (content: string): string => {
      return expandEmbeddedStructuredValues(content, options);
    },
  };
}

/** Configuration shape consumed by {@link buildRegistry}. */
export interface RegistryConfig {
  readonly json: { readonly fileExtensions: readonly string[] };
  readonly yaml: { readonly fileExtensions: readonly string[] };
  readonly structuredData: { readonly canonicalizeToJson: boolean };
  readonly embeddedJson: {
    readonly enabled: boolean;
    readonly fileExtensions: readonly string[];
    readonly autoDetect: boolean;
    readonly keys: readonly string[];
    readonly keyPattern: string;
  };
}

/**
 * Builds a registry from configuration. JSON and YAML structured-data formatters
 * are always registered; the standalone embedded-JSON formatter is registered
 * only for extensions not already handled by the YAML formatter.
 */
export function buildRegistry(config: RegistryConfig): FormatterRegistry {
  const registry = new FormatterRegistry();
  const yamlExtensions = new Set(
    config.yaml.fileExtensions.map((ext) => ext.toLowerCase()),
  );

  registry.register(
    createJsonFormatter({
      extensions: config.json.fileExtensions,
      canonicalizeToJson: config.structuredData.canonicalizeToJson,
    }),
  );

  registry.register(
    createYamlFormatter({
      extensions: config.yaml.fileExtensions,
      canonicalizeToJson: config.structuredData.canonicalizeToJson,
      embeddedJson: config.embeddedJson.enabled
        ? {
            extensions: config.yaml.fileExtensions,
            autoDetect: config.embeddedJson.autoDetect,
            keys: config.embeddedJson.keys,
            keyPattern: config.embeddedJson.keyPattern,
          }
        : undefined,
    }),
  );

  if (config.embeddedJson.enabled) {
    const standaloneEmbeddedExtensions = config.embeddedJson.fileExtensions.filter(
      (ext) => !yamlExtensions.has(ext.toLowerCase()),
    );
    if (standaloneEmbeddedExtensions.length > 0) {
      registry.register(
        createEmbeddedJsonFormatter({
          extensions: standaloneEmbeddedExtensions,
          autoDetect: config.embeddedJson.autoDetect,
          keys: config.embeddedJson.keys,
          keyPattern: config.embeddedJson.keyPattern,
        }),
      );
    }
  }

  return registry;
}

/** Creates a registry using built-in defaults (JSON + YAML + embedded JSON). */
export function createDefaultRegistry(): FormatterRegistry {
  return buildRegistry({
    json: { fileExtensions: ['json'] },
    yaml: { fileExtensions: ['yaml', 'yml'] },
    structuredData: { canonicalizeToJson: true },
    embeddedJson: {
      enabled: true,
      fileExtensions: ['yaml', 'yml'],
      autoDetect: true,
      keys: [],
      keyPattern: '',
    },
  });
}

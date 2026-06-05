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

/**
 * Creates a JSON formatter that re-serialises minified/single-line JSON with
 * two-space indentation. Falls back to the original content on parse failure so
 * that partial or non-standard JSON still diffs.
 *
 * @param extensions Extensions (no leading dot) this formatter handles.
 */
export function createJsonFormatter(extensions: readonly string[]): Formatter {
  return {
    id: 'json',
    extensions,
    format: (content: string): string => {
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // Malformed JSON — show it verbatim rather than failing the diff.
        return content;
      }
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
 *   `- attributeValue: "{\"a\":1}"`
 * Captures: (1) indentation, (2) key, (3) quote char, (4) raw inner value.
 */
const QUOTED_ENTRY = /^(\s*)(?:-\s+)?(["']?)([^:"']+)\2:\s+(['"])(.*)\4\s*$/;

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
      const lines = content.split('\n');
      const out: string[] = [];

      for (const line of lines) {
        const match = QUOTED_ENTRY.exec(line);
        if (match === null) {
          out.push(line);
          continue;
        }

        const [, indent, , key, quote, rawValue] = match;
        if (!isKeyEligible(key, options)) {
          out.push(line);
          continue;
        }

        const literal = unescapeYamlScalar(quote, rawValue);
        const expanded = tryExpandJson(literal);
        if (expanded === undefined) {
          out.push(line);
          continue;
        }

        // Emit `key: |-` then the pretty JSON indented two spaces beyond the
        // key. A block scalar keeps the expansion valid-looking YAML for the
        // read-only diff view.
        const blockIndent = `${indent}  `;
        out.push(`${indent}${key}: |-`);
        for (const jsonLine of expanded.split('\n')) {
          out.push(`${blockIndent}${jsonLine}`);
        }
      }

      return out.join('\n');
    },
  };
}

/**
 * Pretty-prints `value` if it is JSON describing an object or array. Returns
 * `undefined` for scalars or non-JSON so callers can leave the line untouched.
 */
function tryExpandJson(value: string): string | undefined {
  const trimmed = value.trim();
  // Cheap pre-check: only objects/arrays are worth expanding.
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return undefined;
  }
}

/** Configuration shape consumed by {@link buildRegistry}. */
export interface RegistryConfig {
  readonly json: { readonly fileExtensions: readonly string[] };
  readonly embeddedJson: {
    readonly enabled: boolean;
    readonly fileExtensions: readonly string[];
    readonly autoDetect: boolean;
    readonly keys: readonly string[];
    readonly keyPattern: string;
  };
}

/**
 * Builds a registry from configuration. The standalone JSON formatter is always
 * registered; the embedded-JSON formatter is registered only when enabled.
 *
 * To add a new format later, register it here (or call `registry.register`
 * from anywhere). For example:
 *
 * ```ts
 * registry.register({
 *   id: 'xml',
 *   extensions: ['xml', 'svg'],
 *   format: (content) => prettifyXml(content),
 * });
 * ```
 */
export function buildRegistry(config: RegistryConfig): FormatterRegistry {
  const registry = new FormatterRegistry();
  registry.register(createJsonFormatter(config.json.fileExtensions));
  if (config.embeddedJson.enabled) {
    registry.register(
      createEmbeddedJsonFormatter({
        extensions: config.embeddedJson.fileExtensions,
        autoDetect: config.embeddedJson.autoDetect,
        keys: config.embeddedJson.keys,
        keyPattern: config.embeddedJson.keyPattern,
      }),
    );
  }
  return registry;
}

/** Creates a registry using built-in defaults (JSON + embedded JSON in YAML). */
export function createDefaultRegistry(): FormatterRegistry {
  return buildRegistry({
    json: { fileExtensions: ['json'] },
    embeddedJson: {
      enabled: true,
      fileExtensions: ['yaml', 'yml'],
      autoDetect: true,
      keys: [],
      keyPattern: '',
    },
  });
}

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
 * JSON formatter: re-serialises minified/single-line JSON with two-space
 * indentation. Falls back to the original content on parse failure so that
 * partial or non-standard JSON still diffs.
 */
export const jsonFormatter: Formatter = {
  id: 'json',
  extensions: ['json'],
  format: (content: string): string => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Malformed JSON — show it verbatim rather than failing the diff.
      return content;
    }
  },
};

/**
 * Creates a registry pre-populated with the built-in formatters.
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
export function createDefaultRegistry(): FormatterRegistry {
  const registry = new FormatterRegistry();
  registry.register(jsonFormatter);
  return registry;
}

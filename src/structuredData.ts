import * as yaml from 'yaml';

/** How the on-disk file is encoded before pretty-printing for the diff view. */
export type SourceFormat = 'json' | 'yaml';

/**
 * One-line banner prepended to virtual diff content so each side shows whether
 * the underlying file is JSON or YAML.
 */
export function formatOriginBadge(format: SourceFormat): string {
  return format === 'json'
    ? '// GitLineDiff · origin: JSON\n'
    : '# GitLineDiff · origin: YAML\n';
}

/** Parses JSON text; returns `undefined` on failure. */
export function tryParseJson(content: string): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses YAML text; returns `undefined` on failure. */
export function tryParseYaml(content: string): unknown | undefined {
  try {
    return yaml.parse(content, { prettyErrors: false }) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Recursively coerces string values that contain embedded JSON or YAML object/array
 * documents into parsed structures. Useful after block-scalar expansion, where
 * structured payloads are still string-typed in the parsed document.
 */
export function deepCoerceEmbeddedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryParseJson(trimmed);
      if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
        return deepCoerceEmbeddedJson(parsed);
      }
    } else if (trimmed.length > 0) {
      const parsed = tryParseYaml(trimmed);
      if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
        return deepCoerceEmbeddedJson(parsed);
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => deepCoerceEmbeddedJson(entry));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepCoerceEmbeddedJson(entry);
    }
    return out;
  }
  return value;
}

/**
 * Serialises structured data for side-by-side diffing. When
 * `canonicalizeToJson` is true, both JSON and YAML sources are rendered as
 * pretty JSON so semantically equivalent documents compare cleanly even across
 * formats.
 */
export function serializeStructured(
  value: unknown,
  sourceFormat: SourceFormat,
  canonicalizeToJson: boolean,
): string {
  if (canonicalizeToJson || sourceFormat === 'json') {
    return JSON.stringify(value, null, 2);
  }
  return yaml.stringify(value, { indent: 2, lineWidth: 0 });
}

/**
 * Parses file content according to `sourceFormat`, pretty-prints it, and
 * prepends an origin badge. Returns `undefined` when the content is not valid
 * structured data in that format.
 */
export function formatStructuredDocument(
  content: string,
  sourceFormat: SourceFormat,
  canonicalizeToJson: boolean,
): string | undefined {
  const parsed =
    sourceFormat === 'json' ? tryParseJson(content) : tryParseYaml(content);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const normalized =
    sourceFormat === 'yaml' ? deepCoerceEmbeddedJson(parsed) : parsed;
  const body = serializeStructured(normalized, sourceFormat, canonicalizeToJson);
  return formatOriginBadge(sourceFormat) + body;
}

/**
 * Pretty-prints a JSON object/array literal (used when expanding embedded
 * values). Returns `undefined` for scalars or invalid JSON.
 */
export function tryExpandJson(value: string): string | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return undefined;
  }
  const parsed = tryParseJson(trimmed);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  return JSON.stringify(parsed, null, 2);
}

/**
 * Pretty-prints YAML text describing an object or array. Returns `undefined`
 * for scalars or invalid YAML.
 */
export function tryExpandYaml(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = tryParseYaml(trimmed);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  return yaml.stringify(parsed, { indent: 2, lineWidth: 0 });
}

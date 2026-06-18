import * as yaml from 'yaml';

/** How the on-disk file is encoded before pretty-printing for the diff view. */
export type SourceFormat = 'json' | 'yaml';

/** How structured data is rendered in the diff view. */
export type SerializationFormat = 'json' | 'yaml';

/** Cross-format conversion applied on the original (left) diff side. */
export type ConversionKind = 'yaml-to-json' | 'json-to-yaml';

/** Metadata for tab/file decorations (not embedded in document text). */
export interface DiffSideMetadata {
  readonly originFormat: SourceFormat;
  readonly conversion: ConversionKind | undefined;
}

/** Options passed when formatting one side of a structured-data diff. */
export interface StructuredFormatOptions {
  /** When true, both sides serialize using {@link targetSerialization}. */
  readonly crossFormatCompare: boolean;
  /** Serialization format taken from the modified (right) diff side. */
  readonly targetSerialization?: SerializationFormat;
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

/** Returns the on-disk structured format implied by a file extension. */
export function sourceFormatFromExtension(filePath: string): SourceFormat | undefined {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return undefined;
  }
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  if (ext === 'json') {
    return 'json';
  }
  if (ext === 'yaml' || ext === 'yml') {
    return 'yaml';
  }
  return undefined;
}

/**
 * Recursively coerces string values that contain embedded JSON or YAML object/array
 * documents into parsed structures. Useful after block-scalar expansion, where
 * structured payloads are still string-typed in the parsed document.
 */
export function deepCoerceEmbeddedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const coerced = coerceLiteralToStructure(value);
    if (coerced !== undefined) {
      return deepCoerceEmbeddedJson(coerced);
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

/** Coerces a scalar string into a structured value when it contains JSON or YAML. */
export function coerceLiteralToStructure(literal: string): unknown | undefined {
  const trimmed = literal.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  }
  const parsed = tryParseYaml(trimmed);
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    return parsed;
  }
  return undefined;
}

/** Detects whether a structured literal serialises as JSON or YAML on disk. */
export function detectLiteralSerialization(literal: string): SerializationFormat | undefined {
  const trimmed = literal.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
      return 'json';
    }
  }
  const parsed = tryParseYaml(trimmed);
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    return 'yaml';
  }
  return undefined;
}

/** Minimal scan options for detecting embedded structured literals in YAML text. */
export interface EmbeddedScanOptions {
  readonly autoDetect: boolean;
  readonly keys: readonly string[];
  readonly keyPattern: string;
}

const QUOTED_ENTRY = /^(\s*)(?:-\s+)?(["']?)([^:"']+)\2:\s*(['"])(.*)\4\s*$/;

function isKeyEligible(key: string, options: EmbeddedScanOptions): boolean {
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
        return false;
      }
    }
    return false;
  }

  return options.autoDetect;
}

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
 * Scans YAML text for eligible embedded structured literals and returns the
 * serialization format of the first one found.
 */
export function detectEmbeddedSerialization(
  content: string,
  options: EmbeddedScanOptions,
): SerializationFormat | undefined {
  for (const line of content.split('\n')) {
    const match = QUOTED_ENTRY.exec(line);
    if (match === null) {
      continue;
    }
    const [, , , key, quote, rawValue] = match;
    if (!isKeyEligible(key, options)) {
      continue;
    }
    const literal = unescapeYamlScalar(quote, rawValue);
    const format = detectLiteralSerialization(literal);
    if (format !== undefined) {
      return format;
    }
  }
  return undefined;
}

/**
 * Chooses the serialization format for a diff side. Embedded structured values
 * take precedence; otherwise the on-disk file format is used.
 */
export function detectSerializationFormat(
  content: string,
  filePath: string,
  embeddedScan?: EmbeddedScanOptions,
): SerializationFormat | undefined {
  const sourceFormat = sourceFormatFromExtension(filePath);
  if (sourceFormat === undefined) {
    return undefined;
  }
  if (sourceFormat === 'json') {
    return 'json';
  }
  if (embeddedScan !== undefined) {
    const embedded = detectEmbeddedSerialization(content, embeddedScan);
    if (embedded !== undefined) {
      return embedded;
    }
  }
  return 'yaml';
}

/**
 * Serialises structured data for side-by-side diffing using the requested
 * target format.
 */
export function serializeStructured(
  value: unknown,
  target: SerializationFormat,
): string {
  if (target === 'json') {
    return JSON.stringify(value, null, 2);
  }
  return yaml.stringify(value, { indent: 2, lineWidth: 0 });
}

function resolveTargetSerialization(
  sourceFormat: SourceFormat,
  options: StructuredFormatOptions,
): SerializationFormat {
  if (options.crossFormatCompare && options.targetSerialization !== undefined) {
    return options.targetSerialization;
  }
  return sourceFormat === 'json' ? 'json' : 'yaml';
}

/**
 * Parses file content according to `sourceFormat` and pretty-prints it.
 * Returns `undefined` when the content is not valid structured data in that format.
 */
export function formatStructuredDocument(
  content: string,
  sourceFormat: SourceFormat,
  options: StructuredFormatOptions,
): string | undefined {
  const parsed =
    sourceFormat === 'json' ? tryParseJson(content) : tryParseYaml(content);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const normalized =
    sourceFormat === 'yaml' ? deepCoerceEmbeddedJson(parsed) : parsed;
  const target = resolveTargetSerialization(sourceFormat, options);
  return serializeStructured(normalized, target);
}

/**
 * Pretty-prints a JSON object/array literal (used when expanding embedded
 * values). Returns `undefined` for scalars or invalid JSON.
 */
export function tryExpandJson(value: string): string | undefined {
  const coerced = coerceLiteralToStructure(value);
  if (coerced === undefined) {
    return undefined;
  }
  return serializeStructured(coerced, 'json');
}

/**
 * Pretty-prints YAML text describing an object or array. Returns `undefined`
 * for scalars or invalid YAML.
 */
export function tryExpandYaml(value: string): string | undefined {
  const coerced = coerceLiteralToStructure(value);
  if (coerced === undefined) {
    return undefined;
  }
  return serializeStructured(coerced, 'yaml');
}

/** Expands a structured literal using the target serialization format. */
export function expandLiteral(
  literal: string,
  target: SerializationFormat,
): string | undefined {
  const coerced = coerceLiteralToStructure(literal);
  if (coerced === undefined) {
    return undefined;
  }
  return serializeStructured(coerced, target);
}

/** Builds decoration metadata for one diff side. */
export function buildDiffSideMetadata(
  filePath: string,
  rawContent: string,
  side: 'original' | 'modified',
  options: StructuredFormatOptions,
  embeddedScan?: EmbeddedScanOptions,
): DiffSideMetadata | undefined {
  const originFormat = sourceFormatFromExtension(filePath);
  if (originFormat === undefined) {
    return undefined;
  }

  if (!options.crossFormatCompare || options.targetSerialization === undefined) {
    return { originFormat, conversion: undefined };
  }

  const sideSerialization = detectSerializationFormat(rawContent, filePath, embeddedScan);
  if (sideSerialization === undefined) {
    return { originFormat, conversion: undefined };
  }

  if (side === 'modified' || sideSerialization === options.targetSerialization) {
    return { originFormat, conversion: undefined };
  }

  const conversion: ConversionKind =
    options.targetSerialization === 'json' ? 'yaml-to-json' : 'json-to-yaml';
  return { originFormat, conversion };
}

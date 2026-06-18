import * as vscode from 'vscode';

/** Top-level configuration section for all `gitlinediff.*` settings. */
export const CONFIG_SECTION = 'gitlinediff';

/** Settings controlling the standalone JSON formatter. */
export interface JsonConfig {
  /** Extensions (no leading dot) treated as standalone JSON. */
  readonly fileExtensions: readonly string[];
}

/** Settings controlling standalone YAML structured-data formatting. */
export interface YamlConfig {
  /** Extensions (no leading dot) treated as standalone YAML. */
  readonly fileExtensions: readonly string[];
}

/** Settings shared by JSON and YAML structured-data formatters. */
export interface StructuredDataConfig {
  /**
   * When true, structured values on both diff sides are rendered using the
   * modified (right) side's serialization format so cross-format changes
   * compare cleanly. A tab badge shows any conversion on the original side.
   */
  readonly canonicalizeToJson: boolean;
}

/** Settings controlling expansion of JSON embedded inside other files. */
export interface EmbeddedJsonConfig {
  readonly enabled: boolean;
  /** Extensions (no leading dot) scanned for embedded JSON values. */
  readonly fileExtensions: readonly string[];
  /**
   * When no explicit `keys`/`keyPattern` are set, expand any key whose value
   * parses as a JSON object/array.
   */
  readonly autoDetect: boolean;
  /** Exact key names to expand. When non-empty, restricts eligibility. */
  readonly keys: readonly string[];
  /** Optional regex (as a string) matched against key names. */
  readonly keyPattern: string;
}

/** Fully-typed snapshot of the extension's configuration. */
export interface GitLineDiffConfig {
  readonly json: JsonConfig;
  readonly yaml: YamlConfig;
  readonly structuredData: StructuredDataConfig;
  readonly embeddedJson: EmbeddedJsonConfig;
}

/**
 * Reads a setting with a typed fallback. VS Code returns `undefined` for unset
 * values; the explicit default keeps the rest of the code free of `undefined`
 * checks and avoids `any`.
 */
function read<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: T,
): T {
  const value = config.get<T>(key);
  return value === undefined ? fallback : value;
}

/** Reads the current `gitlinediff.*` configuration into a typed snapshot. */
export function readConfig(): GitLineDiffConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    json: {
      fileExtensions: read<string[]>(config, 'json.fileExtensions', ['json']),
    },
    yaml: {
      fileExtensions: read<string[]>(config, 'yaml.fileExtensions', ['yaml', 'yml']),
    },
    structuredData: {
      canonicalizeToJson: read<boolean>(
        config,
        'structuredData.canonicalizeToJson',
        true,
      ),
    },
    embeddedJson: {
      enabled: read<boolean>(config, 'embeddedJson.enabled', true),
      fileExtensions: read<string[]>(config, 'embeddedJson.fileExtensions', ['yaml', 'yml']),
      autoDetect: read<boolean>(config, 'embeddedJson.autoDetect', true),
      keys: read<string[]>(config, 'embeddedJson.keys', []),
      keyPattern: read<string>(config, 'embeddedJson.keyPattern', ''),
    },
  };
}

/** Returns `true` if a configuration change event affects this extension. */
export function affectsConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}

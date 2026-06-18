#!/usr/bin/env python3
"""Convert a YAML file into a single-line escaped YAML string."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError as exc:
    raise SystemExit(
        "PyYAML is required. Install it with: pip install pyyaml"
    ) from exc


def yaml_to_escaped_string(data: object) -> str:
    """Pretty-print YAML and escape it as a quoted single-line string."""
    pretty = yaml.dump(
        data,
        default_flow_style=False,
        indent=2,
        allow_unicode=True,
        sort_keys=False,
        width=float("inf"),
    )

    escaped = pretty.replace("\\", "\\\\")
    escaped = escaped.replace('"', '\\"')
    escaped = escaped.replace("\r\n", "\n").replace("\r", "\n")
    escaped = escaped.replace("\n", "\\r\\n")

    return f'"{escaped}"'


def read_yaml_file(path: Path) -> object:
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")

    if not path.is_file():
        raise ValueError(f"Input path is not a file: {path}")

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise OSError(f"Unable to read input file: {path}") from exc

    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        if mark is not None:
            raise ValueError(
                f"Invalid YAML in {path} "
                f"(line {mark.line + 1}, column {mark.column + 1}): {exc}"
            ) from exc
        raise ValueError(f"Invalid YAML in {path}: {exc}") from exc


def write_output(path: Path, content: str) -> None:
    try:
        path.write_text(content, encoding="utf-8", newline="\n")
    except OSError as exc:
        raise OSError(f"Unable to write output file: {path}") from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a YAML file into a single-line escaped string "
            '(pretty-printed, with \\" and \\r\\n escapes, wrapped in quotes).'
        )
    )
    parser.add_argument("input", type=Path, help="Path to the input .yaml or .yml file")
    parser.add_argument("output", type=Path, help="Path to the output .txt file")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        data = read_yaml_file(args.input)
        result = yaml_to_escaped_string(data)
        write_output(args.output, result)
    except (FileNotFoundError, ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Wrote escaped YAML string to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

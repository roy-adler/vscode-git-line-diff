#!/usr/bin/env python3
"""Convert a JSON file into a single-line escaped JSON string."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def json_to_escaped_string(data: object) -> str:
    """Pretty-print JSON and escape it as a quoted single-line string."""
    pretty = json.dumps(data, indent=2, ensure_ascii=False)

    escaped = pretty.replace("\\", "\\\\")
    escaped = escaped.replace('"', '\\"')
    escaped = escaped.replace("\r\n", "\n").replace("\r", "\n")
    escaped = escaped.replace("\n", "\\r\\n")

    return f'"{escaped}"'


def read_json_file(path: Path) -> object:
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")

    if not path.is_file():
        raise ValueError(f"Input path is not a file: {path}")

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise OSError(f"Unable to read input file: {path}") from exc

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON in {path} (line {exc.lineno}, column {exc.colno}): {exc.msg}"
        ) from exc


def write_output(path: Path, content: str) -> None:
    try:
        path.write_text(content, encoding="utf-8", newline="\n")
    except OSError as exc:
        raise OSError(f"Unable to write output file: {path}") from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a JSON file into a single-line escaped string "
            "(pretty-printed, with \\\" and \\r\\n escapes, wrapped in quotes)."
        )
    )
    parser.add_argument("input", type=Path, help="Path to the input .json file")
    parser.add_argument("output", type=Path, help="Path to the output .txt file")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        data = read_json_file(args.input)
        result = json_to_escaped_string(data)
        write_output(args.output, result)
    except (FileNotFoundError, ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Wrote escaped JSON string to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

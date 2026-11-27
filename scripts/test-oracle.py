#!/usr/bin/env python3
"""CPython oracle for Grimoire-migrated Python files (Requirement 9.3, design R3-9).

The Grimoire never runs CPython at request time. This script is a CI-only
oracle: it runs ``ast.parse`` from the *running* CPython interpreter with an
explicit ``feature_version`` so that Python 2 syntax which newer parsers still
accept in a compatibility mode (for example ``except E, e:`` on CPython 3.14)
is still reported as a ``SyntaxError``.

For every input file the oracle prints one JSON record of exactly this shape::

    {"ok": true, "file": "a.py", "featureVersion": "3.13", "errors": []}

``errors`` holds one object per ``SyntaxError`` with ``message``, ``line`` and
``column``. The exit code is 0 when every file passes, 1 when at least one file
reports a ``SyntaxError`` and 2 for a usage or I/O error.

Usage::

    test-oracle.py --file <path> [--file <path> ...] [--json]
    test-oracle.py --dir <dir> [--json]
    test-oracle.py --stdin --filename <name> [--json]
    test-oracle.py --self-test

Notes
-----
``feature_version`` targets ``(3, 13)`` by default. When the running interpreter
is older than 3.13 and cannot honour that grammar version, the oracle falls back
cleanly to ``(3, sys.version_info.minor)`` and reports the effective version in
the ``featureVersion`` field and on stderr.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys

DEFAULT_FEATURE_VERSION = "3.13"


def parse_feature_version(text: str) -> tuple:
    """Parses ``"3.13"`` into ``(3, 13)`` and rejects malformed values."""
    parts = str(text).strip().split(".")
    if len(parts) != 2:
        raise ValueError("feature version must be in MAJOR.MINOR form")
    try:
        return (int(parts[0]), int(parts[1]))
    except ValueError as exc:  # pragma: no cover - defensive
        raise ValueError("feature version must be numeric") from exc


def _feature_version_supported(major: int, minor: int) -> bool:
    """True when ``ast.parse`` accepts this ``feature_version`` tuple."""
    try:
        ast.parse("pass", filename="<feature-version-probe>", feature_version=(major, minor))
        return True
    except (ValueError, TypeError, SyntaxError):
        return False


def resolve_feature_version(requested):
    """Returns ``(effective, fell_back)`` for the requested feature version.

    ``(3, 13)`` is used whenever the running CPython accepts it. If the host
    interpreter is older than 3.13 (or rejects the tuple), the oracle falls back
    to the interpreter's own minor version so it still reports real syntax
    errors instead of failing to run.
    """
    major, minor = requested
    if major != 3:
        raise ValueError("unsupported feature version major: %d" % major)
    if minor <= sys.version_info.minor and _feature_version_supported(major, minor):
        return (major, minor), False
    fallback = (3, sys.version_info.minor)
    return fallback, True


def format_feature_version(version) -> str:
    return "%d.%d" % (version[0], version[1])


def strip_bom(source: str) -> str:
    """Removes a leading UTF-8 BOM; ``ast.parse`` rejects a BOM left in place."""
    if source and source[0] == "\ufeff":
        return source[1:]
    return source


def check_source(source: str, name: str, feature_version) -> dict:
    """Parses one source string and returns the oracle record for it."""
    errors = []
    try:
        ast.parse(strip_bom(source), filename=name, feature_version=feature_version)
    except SyntaxError as exc:
        errors.append(
            {
                "message": exc.msg if exc.msg is not None else str(exc),
                "line": exc.lineno if exc.lineno is not None else 1,
                "column": exc.offset if exc.offset is not None else 0,
                "text": (exc.text or "").rstrip("\n"),
            }
        )
    return {
        "ok": len(errors) == 0,
        "file": name,
        "featureVersion": format_feature_version(feature_version),
        "errors": errors,
    }


def check_file(path: str, feature_version) -> dict:
    """Reads one file as UTF-8 and returns its oracle record."""
    name = path.replace(os.sep, "/")
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        return {
            "ok": False,
            "file": name,
            "featureVersion": format_feature_version(feature_version),
            "errors": [{"message": "unreadable: %s" % exc, "line": 1, "column": 0, "text": ""}],
        }
    source = raw.decode("utf-8-sig", errors="replace")
    return check_source(source, name, feature_version)


def iter_python_files(root: str):
    """Collects every ``.py`` file under ``root`` in deterministic order."""
    found = []
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in {"__pycache__", ".git", ".venv"})
        for name in sorted(files):
            if name.endswith(".py"):
                found.append(os.path.join(current, name))
    return found


def format_human(record: dict) -> str:
    if record["ok"]:
        return "ok   %s (feature_version=%s)" % (record["file"], record["featureVersion"])
    lines = ["FAIL %s (feature_version=%s)" % (record["file"], record["featureVersion"])]
    for err in record["errors"]:
        lines.append("  line %s:%s: %s" % (err["line"], err["column"], err["message"]))
    return "\n".join(lines)


def run_self_test() -> int:
    """Built-in sanity check; no repository input required."""
    feature_version, _ = resolve_feature_version(parse_feature_version(DEFAULT_FEATURE_VERSION))
    clean = check_source("def f(x):\n    return x\n", "clean.py", feature_version)
    assert clean["ok"] is True and clean["errors"] == [], clean
    broken = check_source('print "hi"\n', "broken.py", feature_version)
    assert broken["ok"] is False and len(broken["errors"]) == 1, broken
    assert broken["errors"][0]["message"], broken
    print(
        "self-test ok (feature_version=%s, python=%s)"
        % (format_feature_version(feature_version), sys.version.split()[0])
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="test-oracle.py",
        description="CPython ast.parse oracle for Grimoire-migrated Python files.",
    )
    parser.add_argument("--file", action="append", default=[], dest="files", help="file to check (repeatable)")
    parser.add_argument("--dir", dest="directory", help="recursively check every .py file under this directory")
    parser.add_argument("--stdin", action="store_true", help="read one source from standard input")
    parser.add_argument("--filename", default="<stdin>", help="filename used for --stdin input")
    parser.add_argument(
        "--feature-version",
        default=DEFAULT_FEATURE_VERSION,
        help="CPython feature version to target (default: %s)" % DEFAULT_FEATURE_VERSION,
    )
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON records")
    parser.add_argument("--self-test", action="store_true", help="run a built-in check and exit")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_test()

    try:
        requested = parse_feature_version(args.feature_version)
        feature_version, fell_back = resolve_feature_version(requested)
    except ValueError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2

    if fell_back:
        print(
            "warning: feature_version %s is unavailable on CPython %s; using %s"
            % (format_feature_version(requested), sys.version.split()[0], format_feature_version(feature_version)),
            file=sys.stderr,
        )

    targets = []
    for path in args.files:
        targets.append((path, None))
    if args.directory:
        for path in iter_python_files(args.directory):
            targets.append((path, None))
    if args.stdin:
        targets.append((args.filename, sys.stdin.read()))

    if not targets:
        print("error: no input given; pass --file, --dir or --stdin", file=sys.stderr)
        return 2

    records = []
    for path, literal in targets:
        if literal is not None:
            records.append(check_source(literal, path.replace(os.sep, "/"), feature_version))
        else:
            records.append(check_file(path, feature_version))

    if args.json:
        for record in records:
            print(json.dumps(record, separators=(", ", ": ")))
    else:
        for record in records:
            print(format_human(record))

    return 0 if all(record["ok"] for record in records) else 1


if __name__ == "__main__":
    sys.exit(main())


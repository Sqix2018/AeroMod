"""Static sanity check for the src/ tree.

Parses every module, verifies each require() resolves to a real file, and
cross-checks that names read off a required module are actually exported by it.
Frida has no type checker and errors inside UI callbacks are swallowed, so this
catches the class of mistake that otherwise shows up as a tab that silently
stops updating.
"""

import glob
import os
import re
import sys

import esprima

SRC = "src"

COMMENT = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)


def strip_comments(source):
    """Comments name other modules in prose, which would look like real uses."""
    return COMMENT.sub("", source)


def parse_all(files):
    problems = []
    for path in files:
        with open(path, encoding="utf-8") as handle:
            try:
                esprima.parseScript(handle.read())
            except Exception as exc:  # noqa: BLE001 - report whatever esprima says
                problems.append("PARSE  {0}: {1}".format(path, exc))
    return problems


def exports_of(path):
    """Names on module.exports, covering both shorthand and `key: value`."""
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    match = re.search(r"module\.exports\s*=\s*\{(.*?)\n\};", source, re.S)
    if not match:
        return None
    names = set()
    for entry in re.findall(r"([A-Za-z_$][\w$]*)\s*(?::|,|\s*$)", match.group(1)):
        names.add(entry)
    return names


def main():
    files = sorted(glob.glob(os.path.join(SRC, "**", "*.js"), recursive=True))
    problems = parse_all(files + ["dist/aerox-tas.js"])

    for path in files:
        directory = os.path.dirname(path)
        with open(path, encoding="utf-8") as handle:
            source = strip_comments(handle.read())

        aliases = {}
        pattern = r"const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['\"]([^'\"]+)['\"]\)"
        for alias, target in re.findall(pattern, source):
            resolved = os.path.normpath(os.path.join(directory, target + ".js"))
            if not os.path.exists(resolved):
                problems.append("MISSING {0} -> {1}".format(path, target))
                continue
            aliases[alias] = resolved

        for alias, resolved in aliases.items():
            exported = exports_of(resolved)
            if exported is None:
                continue
            used = set(re.findall(r"\b" + re.escape(alias) + r"\.([A-Za-z_$][\w$]*)", source))
            for name in sorted(used - exported):
                problems.append(
                    "NO EXPORT {0}: {1}.{2} not exported by {3}".format(
                        path, alias, name, os.path.basename(resolved)
                    )
                )

    for line in problems:
        print(line)
    print("checked {0} files, {1} problems".format(len(files) + 1, len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Read-only reader for Mewgenics `resources.gpak`.

Format (verified against build 25143593: index size + sum of sizes == file size):

    u32 count
    count x { u16 path_len; char path[path_len]; u32 size }
    file bodies, concatenated in index order, no compression, no stored offsets

Commands:
    gpak.py list   [--prefix data/] [--ext .gon]          list entries (offset, size, path)
    gpak.py cat    <path>                                 print one entry to stdout (text)
    gpak.py extract <out_dir> [--prefix data/] [--ext .gon]
                                                          extract matching entries under out_dir
    gpak.py stats                                         counts by top directory and extension

The archive is opened read-only and never modified. Extracted assets are the
game's copyrighted content: keep them in a git-ignored folder, never redistribute.
"""
from __future__ import annotations

import argparse
import collections
import os
import struct
import sys
from dataclasses import dataclass

DEFAULT_GPAK = r"C:\Program Files (x86)\Steam\steamapps\common\Mewgenics\resources.gpak"


@dataclass(frozen=True)
class Entry:
    path: str
    size: int
    offset: int


def read_index(f) -> list[Entry]:
    f.seek(0)
    (count,) = struct.unpack("<I", f.read(4))
    entries: list[Entry] = []
    raw: list[tuple[str, int]] = []
    pos = 4
    for _ in range(count):
        (plen,) = struct.unpack("<H", f.read(2))
        path = f.read(plen).decode("utf-8")
        (size,) = struct.unpack("<I", f.read(4))
        raw.append((path, size))
        pos += 2 + plen + 4
    offset = pos
    for path, size in raw:
        entries.append(Entry(path, size, offset))
        offset += size
    f.seek(0, os.SEEK_END)
    total = f.tell()
    if offset != total:
        print(f"warning: index+data = {offset} but file size = {total}; "
              "format assumption violated, refusing to trust offsets", file=sys.stderr)
        sys.exit(2)
    return entries


def matches(e: Entry, prefix: str | None, ext: str | None) -> bool:
    if prefix and not e.path.startswith(prefix):
        return False
    if ext and not e.path.endswith(ext):
        return False
    return True


def safe_join(root: str, rel: str) -> str:
    # entries are forward-slash relative paths; refuse anything that escapes root
    if rel.startswith(("/", "\\")) or ":" in rel or any(p in ("..", "") for p in rel.split("/")):
        raise ValueError(f"refusing unsafe entry path: {rel!r}")
    out = os.path.normpath(os.path.join(root, *rel.split("/")))
    if os.path.commonpath([os.path.abspath(root), os.path.abspath(out)]) != os.path.abspath(root):
        raise ValueError(f"entry escapes output root: {rel!r}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gpak", default=DEFAULT_GPAK)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list")
    p_list.add_argument("--prefix")
    p_list.add_argument("--ext")
    p_cat = sub.add_parser("cat")
    p_cat.add_argument("path")
    p_ext = sub.add_parser("extract")
    p_ext.add_argument("out_dir")
    p_ext.add_argument("--prefix")
    p_ext.add_argument("--ext")
    sub.add_parser("stats")
    args = ap.parse_args()

    with open(args.gpak, "rb") as f:
        entries = read_index(f)

        if args.cmd == "list":
            for e in entries:
                if matches(e, args.prefix, args.ext):
                    print(f"{e.offset}\t{e.size}\t{e.path}")
            return 0

        if args.cmd == "stats":
            by_dir = collections.Counter(e.path.split("/")[0] for e in entries)
            by_ext = collections.Counter(os.path.splitext(e.path)[1] or "(none)" for e in entries)
            print(f"entries: {len(entries)}")
            print("by top dir:", dict(by_dir.most_common()))
            print("by ext:", dict(by_ext.most_common()))
            return 0

        if args.cmd == "cat":
            e = next((x for x in entries if x.path == args.path), None)
            if e is None:
                print(f"not found: {args.path}", file=sys.stderr)
                return 1
            f.seek(e.offset)
            sys.stdout.buffer.write(f.read(e.size))
            return 0

        if args.cmd == "extract":
            os.makedirs(args.out_dir, exist_ok=True)
            n = 0
            total = 0
            for e in entries:
                if not matches(e, args.prefix, args.ext):
                    continue
                dst = safe_join(args.out_dir, e.path)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                f.seek(e.offset)
                with open(dst, "wb") as o:
                    remaining = e.size
                    while remaining:
                        chunk = f.read(min(remaining, 8 << 20))
                        if not chunk:
                            raise IOError(f"short read in {e.path}")
                        o.write(chunk)
                        remaining -= len(chunk)
                n += 1
                total += e.size
            print(f"extracted {n} entries, {total} bytes, to {args.out_dir}")
            return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

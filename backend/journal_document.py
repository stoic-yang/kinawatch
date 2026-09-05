from __future__ import annotations

import re


UTF8_BOM = b"\xef\xbb\xbf"
_PROPERTY_KEY = re.compile(r"^[^\s#][^:\r\n]*:(?:[ \t]|$)")


def split_document(content: bytes) -> tuple[bytes, str, bool]:
    """Separate a note's immutable properties prefix without normalizing bytes.

    Obsidian properties are a YAML mapping, not arbitrary YAML scalar text.
    Requiring a mapping-looking first value keeps ordinary Markdown between
    two horizontal rules in the editable body. Empty properties are supported.
    The prefix includes the UTF-8 BOM and closing delimiter's line ending, but
    never consumes blank lines or other content after that delimiter.
    """
    bom = UTF8_BOM if content.startswith(UTF8_BOM) else b""
    source = content[len(bom):]
    lines = source.splitlines(keepends=True)
    if not lines or lines[0].rstrip(b"\r\n \t") != b"---":
        return bom, source.decode("utf-8"), False

    offset = len(lines[0])
    for index, line in enumerate(lines[1:], start=1):
        offset += len(line)
        if line.rstrip(b"\r\n \t") not in {b"---", b"..."}:
            continue
        properties = b"".join(lines[1:index]).decode("utf-8")
        first = next(
            (line for line in properties.splitlines()
             if line.strip() and not line.lstrip().startswith("#")),
            "",
        )
        if not first and properties.strip():
            # A Markdown heading between rules is also a YAML comment. With
            # no actual property, keep it in the body instead of hiding it.
            break
        if first and not (
            _PROPERTY_KEY.match(first)
            or first.startswith("{")
        ):
            break
        return bom + source[:offset], source[offset:].decode("utf-8"), True
    return bom, source.decode("utf-8"), False


def replace_document_body(content: bytes, markdown: str) -> bytes:
    """Retain existing properties verbatim and replace only the Markdown body.

    A new body can itself start with a YAML mapping. With no prior properties,
    that is otherwise indistinguishable from frontmatter on the next read.
    Only this ambiguous case gets an empty properties envelope; no user text
    is changed or hidden. Plain horizontal rules do not need an envelope.
    """
    prefix, _, has_frontmatter = split_document(content)
    body = markdown.encode("utf-8")
    if has_frontmatter:
        if body and not prefix.endswith((b"\n", b"\r")):
            # A properties-only file may end immediately after its delimiter.
            prefix += b"\n"
    else:
        new_prefix, _, new_frontmatter = split_document(body)
        if new_frontmatter or new_prefix:
            prefix += b"---\n---\n"
    return prefix + body

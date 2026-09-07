# Security Policy

## Supported version

The latest `main` branch is the supported development version during the
initial open-source phase.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting when it is available. If
it is not available, open a minimal issue asking the maintainer for a private
contact channel. Do not put personal paths, note contents, ActivityWatch data,
database locations, or exploit details in that issue.

## Security model

- The HTTP service has no remote-user authentication because it is designed to
  bind only to `127.0.0.1` or `localhost`; non-loopback binds are rejected.
- HTTP requests require a loopback `Host`. Browser API requests carrying a
  cross-site Fetch Metadata signal are rejected, and every supplied `Origin`
  must match the request authority. Responses prohibit framing, MIME sniffing,
  and cross-origin resource reuse.
- Journal writes are disabled in the public example configuration.
- Manual activity corrections are also disabled in the public example. When
  enabled, they write only a KinaWatch-owned overlay using source fingerprints,
  overlay revisions, locking, atomic replacement, and bounded undo history.
- When enabled locally, writes are limited to a narrow target whitelist inside
  either the KinaWatch-managed data directory or the configured Obsidian vault:
  a selected daily document body or field, one period-review field, and the
  configured permanent and beliefs Markdown files. Document-body writes preserve
  existing YAML properties and BOM. Standing-note paths are configuration-owned, relative, and
  never accepted from a browser request. Both providers use optimistic
  fingerprints, per-note locking, atomic replacement, and conflict rejection.
- The daily document and beliefs editors save after user input pauses when writes
  are enabled; opening a page never creates a note. Workflow descriptions
  require explicit saves. Unsaved drafts remain in local browser storage, and
  an external file change requires a deliberate conflict-resolution choice.
- ActivityWatch data and local configuration are read-only inputs.
- KinaWatch accepts only loopback ActivityWatch server URLs in v1 and never
  writes ActivityWatch buckets or events. ActivityWatch requests ignore
  environment proxy variables and reject redirects, so a loopback URL cannot
  become an external request hop. A correction whose source event has changed
  is rejected instead of being silently reapplied.
- A user who changes the bind restriction, exposes the port through a proxy,
  or runs with an untrusted local configuration leaves the supported threat
  model.

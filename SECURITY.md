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
- Journal writes are disabled in the public example configuration.
- When enabled locally, writes are limited to a narrow field whitelist inside
  either the KinaWatch-managed data directory or the configured Obsidian vault.
  Both providers use optimistic fingerprints, per-note locking, atomic
  replacement, and conflict rejection.
- ActivityWatch data and local configuration are read-only inputs.
- KinaWatch accepts only loopback ActivityWatch server URLs in v1 and never
  writes ActivityWatch buckets or events.
- A user who changes the bind restriction, exposes the port through a proxy,
  or runs with an untrusted local configuration leaves the supported threat
  model.

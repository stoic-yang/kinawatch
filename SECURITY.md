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
- When enabled locally, writes are limited to a narrow field whitelist and use
  optimistic fingerprints, per-note locking, atomic replacement, and conflict
  rejection.
- ActivityWatch data and upstream configuration are read-only inputs.
- A user who changes the bind restriction, exposes the port through a proxy,
  or runs with an untrusted local configuration leaves the supported threat
  model.

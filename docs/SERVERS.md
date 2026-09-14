# Server monitor

The `#servers` page integrates the existing terminal monitor's Linux collector
into KinaWatch. It shows all NVIDIA GPUs, CPU, memory, disks, swap, uptime and
Python / GPU / related service processes. Process names come from their own
arguments; unknown names remain unknown. Process CPU uses 100% per logical core.
GPU memory is reported in MiB by NVIDIA and displayed as GiB; system memory uses
bytes. Small allocations remain in MiB rather than rounding to zero GiB. Missing measurements never become zero.

CPU, memory, GPU utilization, GPU memory, disk usage and swap share the same
meter layout: label, percentage, bar and measurement details. Disk and swap
meters are always visible alongside the other resources. Capacity percentages
use the displayed used / total amounts. Temperature and power
remain secondary readings under GPU utilization.

Enable it in the private local KinaWatch configuration, then restart the service:

```json
{
  "server_monitor": {
    "enabled": true,
    "hosts": ["compute-a", "compute-b"],
    "jump_host": ""
  }
}
```

Use existing SSH aliases that already authenticate noninteractively and have
verified known-host keys. Empty `jump_host` explicitly selects direct access,
overriding inherited ProxyJump / ProxyCommand. A single optional jump alias may
be configured. No UU integration is required. Credentials remain with OpenSSH;
the public example defaults to disabled with no hosts. Supports 1–8 aliases,
a macOS/Linux client with OpenSSH, and Linux `/proc`, `/usr/bin/python3` and optional `nvidia-smi` on the remote host.
Other operating systems are not supported by this collector.

## Collection and lifecycle

`GET /api/servers` uses the existing loopback Host, same-origin, cross-site and
no-store controls. It accepts no client-supplied hosts, paths or commands and
provides no write / terminal / kill-process endpoint. It starts at most one SSH
stream per configured host, shared by all viewers. The bundled, standard-library
collector is sent through stdin, without installation, file writes or CUDA
imports on the remote server. Server output is bounded and normalized; process
commands are displayed as text, never HTML. No snapshots, command lines or
history are written to disk or journals.

The page loads on first navigation. While visible it polls every three seconds;
leaving it, pausing or hiding the document stops requests. A shared rhythm view
also suspends polling. Each host has a 15-second viewing lease: without requests,
its worker stops and terminates its own SSH child. The lease is independent of
ordinary diary / health requests and KinaWatch's always-on setting. Closing the
HTTP server also shuts down the workers. There is no additional daemon or
WebSocket. The old terminal application remains independent.

Connection startup has a 45-second deadline; an established stream expires
after 20 seconds without a sample. Failures retain SSH stderr and retry after
five seconds while viewed. After ten seconds, retained samples are marked stale
even if transport still appears connected. Freshness uses local monotonic receipt
time; repeated remote timestamps are rejected. A failed HTTP refresh also marks
retained browser data stale. First process CPU readings can be unavailable until
the second sample establishes an interval. The UI supports host selection,
training / GPU / all filters, search, expandable command details and bounded
50-row increments.

## Verification

- `python3 -m unittest discover -s tests -p 'test_server_monitor.py' -v`
- `python3 -m unittest discover -s tests -p 'test_*.py'`
- `npm run test:journal --prefix frontend`
- `npm run build --prefix frontend`
- Read-only live checks: multiple increasing samples per host, direct route,
  paused / hidden-page SSH teardown, resumed collection, desktop and narrow UI.

Subprocess tests use synthetic local streams for fragmentation, errors, timeouts,
oversized records, repeated data, concurrent viewers and lease expiry. They never
connect to real servers. The collector was migrated from the existing standalone
monitor; the terminal UI and its host-specific startup configuration are not
runtime dependencies.

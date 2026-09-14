# MCP services in KinaWatch

Open **服务器 → MCP 服务** (`#servers-mcp`). Choose **添加服务**, select a
real folder with the in-page directory picker, name it, and press **启动服务**.
The card shows progress, then an authenticated HTTPS MCP address. Existing
profiles can be started and stopped; credentials and logs appear only on demand.
Selecting a folder does not copy, upload or rewrite it. Starting a service exposes
the original folder through coding-tools-mcp, including file changes and command
execution in its `safe` mode. This is not a complete macOS system sandbox.

The server page preserves its separate SSH monitoring tab. Switching to MCP
management suspends SSH sampling; MCP services themselves continue when the page
closes or KinaWatch restarts, until explicitly stopped or their processes exit.

## Optional runtime configuration

The Python dashboard keeps its standard-library runtime. Install and maintain
`coding-tools-mcp` in a separate Python environment, and `cloudflared` separately.
The page never installs software or upgrades packages. Current integration was
verified with coding-tools-mcp 0.3.0; it uses public CLI/OAuth/MCP interfaces.
The manager supports macOS and Linux. It is disabled by default.

Private KinaWatch configuration:

```json
{
  "mcp_services": {
    "enabled": true,
    "runtime_python": "/your/mcp-environment/bin/python",
    "cloudflared": "/your/bin/cloudflared",
    "folder_roots": ["~/Projects"],
    "legacy_services": []
  }
}
```

Omit `folder_roots` to browse the current user's home. Browsing is one directory
at a time, bounded to 5,000 entries and 300 returned child folders. It never reads
file contents or scans recursively. Entering an absolute path uses the same
validation. Symlinks resolve before root checks. A service cannot expose the
manager's private state, its credential-bearing legacy service directories,
or any parent of those locations. Folder identity is retained and rechecked on
restart to reject a replaced directory or retargeted link.

New profiles live in `mcp-services` under KinaWatch's platform data directory
(honoring `KINAWATCH_DATA_DIR`). An optional absolute `store_dir` overrides it.
Private directories use mode 0700, profile/state/log files use 0600, with locked,
atomic profile/state changes. Each folder reuses its existing profile. Service
passwords and token-signing secrets are generated locally, outside the workspace;
they never enter Git, normal status responses or page HTML. Viewing an OAuth
password uses a separate explicit POST, and the browser retains it only in the
open card's memory. Logs are bounded and redact the service's two secrets.

## Existing service center compatibility

Locally configured `legacy_services` entries may contain `id`, `name`, and an
absolute `directory` for the existing Service Center's `manage.py`/`settings.json`
profile. Reading uses its existing workspace, process metadata and current
tunnel log; it does not migrate, restart or rotate credentials. Explicit start
and stop use that profile's existing fixed management script and lock. This
adapter is optional; new profiles do not depend on the old Service Center.
The original center remains usable for its profiles.

## Runtime lifecycle and authority

New instances bind only to `127.0.0.1`, on an available dedicated port. They always
enable OAuth and `safe` permissions, disable telemetry, filter inherited provider
credentials/startup environment and use an external runtime directory. The
manager never exposes its own dashboard port through the tunnel. There is no
client-supplied shell command, executable, environment, port or credential option.

Start/stop operations run in detached supervisors, protected by per-profile
locks, so HTTP cancellation or a dashboard restart does not interrupt them.
Status reads observe existing processes and do not start services. Stored process
identities include PID, birth time, owner and session group; a mismatched/reused
PID is not killed. Successful startup requires both local OAuth discovery and
HTTPS OAuth discovery with the correct issuer and registration endpoint. Failed
startup cleans up its newly created processes. A lightweight supervisor couples
the new MCP/tunnel pair: if either exits, it closes the other and clears the URL,
instead of leaving a tunnel pointing at a reusable local port. Explicit stop
closes the group, including commands owned by that MCP process. There is no
automatic restart or login startup for MCP services.

Dashboard APIs use existing loopback Host, same-origin and cross-site checks,
plus a custom header and JSON content type on every MCP management POST:

- `GET /api/mcp/services` — service states, cached for two seconds.
- `GET /api/mcp/folders?path=…` — directory selection only.
- `GET /api/mcp/logs?id=…` — bounded, redacted logs for a registered profile.
- `POST /api/mcp/services` — explicit `{name, workspace}` create/start.
- `POST /api/mcp/action` — explicit `{id, action: "start" | "stop"}`.
- `POST /api/mcp/password` — explicit `{id}` credential access.

All responses use `Cache-Control: no-store`. The management page polls only when
visible; it does not register folders automatically. These endpoints manage an
external MCP runtime and do not expand KinaWatch's own journal write endpoints.

## ChatGPT connection

Enable Developer mode in ChatGPT, create a developer app with the HTTPS MCP URL,
select OAuth and DCR, then enter the service's OAuth password in its authorization
page. Enable that app in a conversation and ask `server_info` to confirm the
workspace before using write tools. UI locations and account/model capabilities
can vary; use the [official Developer mode documentation](https://developers.openai.com/api/docs/guides/developer-mode).

This authorizes ChatGPT to use the MCP resource; it never requires extracting
OpenAI cookies or account tokens. Requests pass through Cloudflare and data read
by ChatGPT reaches OpenAI. Temporary tunnel URLs change after a tunnel restart;
update the ChatGPT app and reauthorize as needed. OAuth expiration can also
require reconnection. A running service/verified HTTPS endpoint does not imply
the user's ChatGPT app has already been created or that a specific model has
successfully called it.

## Verification

Unit tests cover disabled/read-only initialization, directory boundaries,
private profiles, duplicates, replaced folders, credential isolation, explicit
POST requirements, original service preservation, process identity and pair
cleanup. Frontend tests cover action availability, URL validation and request
contracts. Live integration uses only a synthetic workspace for public OAuth
DCR/PKCE, anonymous/wrong-password rejection, code replay rejection, MCP tools,
file create/update/delete, command execution and traversal rejection. Never use
real journals or project files as write fixtures.

Run the full Python suite, `npm run test:journal --prefix frontend`, production
build and read-only Gate 1 before integration. Browser checks include folder
navigation/path entry, selection/cancellation, service display, tab history,
themes and narrow viewports.

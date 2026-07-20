# Energy Budget

The v1 backend performs work only in response to an HTTP request.

- The process binds to `127.0.0.1`.
- The server blocks inside the operating system while waiting for a request.
- There is no file watcher, vault scan, WebSocket, browser heartbeat, or
  background refresh thread.
- Today's ActivityWatch result has a five-minute cache TTL.
- Historical results remain cached until the selected note or upstream
  configuration fingerprint changes, or the user requests `refresh=1`.
- The ActivityWatch database mtime is intentionally not part of the historical
  cache key.
- The server exits after the configured idle timeout.

Gate 1C is measured on an idle process after one request. Expected CPU usage is
near zero.

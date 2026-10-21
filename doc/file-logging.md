# Retained file logging (server.log + access.log)

The server keeps a retained copy of its logs on disk so crash forensics
survive container recreates. Container-stdout logging (`docker logs`) is
unchanged; the files are additive.

This is separate from the three paths in `AGENTS.md` §7: it is not Telemetry
(nothing leaves the host), not Observability (no OTLP endpoint involved),
and not the run log (no database rows). No privacy review is needed for
changes confined to these files: the data stays on the instance volume and
every line passes through the existing HTTP log redaction policy.

## Files

Both live in the instance logs dir (`$PAPERCLIP_HOME/instances/<id>/logs`,
overridable with `PAPERCLIP_LOG_DIR`). In container deployments that dir is
on the retained `/paperclip` volume, so recreating the container does not
delete them; the new process appends to the existing files.

- `server.log`: every pino line (app logs plus the pino-http request lines)
  plus timestamped copies of direct stdout/stderr writes (`console.*`, Node
  fatal prints). Pino lines are JSON; stdio lines look like
  `2026-10-20T01:56:00.123Z stderr <text>` with color codes stripped.
- `access.log`: one JSON line per HTTP request, nothing silenced:
  `{"t":"…","m":"GET","p":"/api/health","s":200,"d":1.2,"id":"7","r":"/"}`
  (`t` finish timestamp, `m` method, `p` redacted path, `s` status,
  `d` duration ms, `id` pino request id for correlation with `server.log`,
  `r` matched route pattern when the router matched one). `p` is the true
  request path, snapshotted before mounted routers strip `req.url`; `r` is
  the pattern inside the mounted router (often just `/`). Paths use the same
  redaction policy as the pino-http lines: no query strings, no credentials,
  webhook ids collapsed to route templates.

## Rotation and crash-safety

- Size-based rotation per file: `server.log` + `server.log.1 … .4` by
  default (10 MiB each, 50 MiB cap; same for `access.log`). Tune with
  `PAPERCLIP_{SERVER,ACCESS}_LOG_MAX_{BYTES,FILES}`.
- Every write is a synchronous append: there is no userspace buffer to lose,
  so a hard crash (uncaught exception, OOM kill) keeps everything up to the
  final line. No `uncaughtException`/`unhandledRejection` listener is
  registered for logging, so crash behavior is unchanged.
- Newest lines are always in the un-suffixed file; `.1` is the previous
  generation. A single oversized line lands oversized rather than spinning
  rotation.
- Logging never breaks serving: an unwritable dir, disk-full, or rotation
  error degrades to stdout-only with a throttled stderr diagnostic.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_FILE_LOGGING` | `true` | `false`/`0`/`no`/`off` disables both files (stdout-only) |
| `PAPERCLIP_LOG_DIR` | instance logs dir | Directory for both files |
| `PAPERCLIP_SERVER_LOG_MAX_BYTES` | `10485760` | Rotation size for `server.log` |
| `PAPERCLIP_SERVER_LOG_MAX_FILES` | `5` | Generations kept for `server.log` |
| `PAPERCLIP_ACCESS_LOG_MAX_BYTES` | `10485760` | Rotation size for `access.log` |
| `PAPERCLIP_ACCESS_LOG_MAX_FILES` | `5` | Generations kept for `access.log` |

Invalid sizes fall back to defaults with a stderr warning. Unit tests run
stdout-only unless they opt in explicitly.

## Forensics recipes

```sh
LOGDIR="$PAPERCLIP_HOME/instances/default/logs"   # adjust to the instance
ls -lt "$LOGDIR"/server.log* "$LOGDIR"/access.log* # newest lines: un-suffixed files

# Request counts per minute around an incident window (all generations):
cat "$LOGDIR"/access.log* | python3 -c "
import json,sys,collections
hits=collections.Counter()
for line in sys.stdin:
    try: o=json.loads(line)
    except ValueError: continue
    if '2026-10-20T01:30' <= o['t'] <= '2026-10-20T02:05': hits[o['t'][:16]]+=1
for minute in sorted(hits): print(minute, hits[minute])
"

# Status mix in the same window:
grep -h '"t":"2026-10-20T01:5' "$LOGDIR"/access.log* | grep -o '"s":[0-9]*' | sort | uniq -c

# What the server printed just before it died (oldest line first):
cat "$LOGDIR"/server.log.4 "$LOGDIR"/server.log.3 "$LOGDIR"/server.log.2 \
    "$LOGDIR"/server.log.1 "$LOGDIR"/server.log 2>/dev/null | tail -100
```

## Rollback

Set `PAPERCLIP_FILE_LOGGING=false` and restart, or revert the change; the
files are additive only and safe to delete once the incident is closed.

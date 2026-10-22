# Retained file logging (server.log + access.log)

The server keeps a retained copy of its logs on disk so crash forensics
survive container recreates. Container-stdout logging (`docker logs`) is
unchanged; the files are additive.

This is separate from the three paths in `AGENTS.md` §5 item 7: it is not
Telemetry (nothing leaves the host), not Observability (no OTLP endpoint
involved), and not the run log (no database rows).

Privacy: the pino lines in `server.log` and every `access.log` line pass
through the existing HTTP log redaction policy. The stdio-tee copies in
`server.log` do NOT: they are raw process output with only ANSI codes
stripped, so anything the process prints (subprocess stderr passthrough,
fatal-error prints) persists verbatim on the instance volume, where it used
to live only in ephemeral container stdout. Treat new stdio writers as
unredacted retained data — they need a privacy review. Changes confined to
rotation, file layout, or the already-redacted lines do not.

## Files

Both live in one directory, resolved in this order: `PAPERCLIP_LOG_DIR`
when set, else the operator's explicitly configured `logging.logDir` from
the instance config file (an omitted `logDir` falls through to the default
even when the server runs under a config file), else the default instance
logs dir (`$PAPERCLIP_HOME/instances/<id>/logs`). In container deployments that
dir is on the retained `/paperclip` volume, so recreating the container does
not delete them; the new process appends to the existing files.

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
  redaction policy as the pino-http lines: no query strings, no credentials
  (invite and board-claim bearer tokens collapse to `:token`), webhook ids
  collapsed to route templates. The loggers mount before the body parsers, so
  parser rejects (malformed JSON, oversized bodies) are logged too.

## Rotation and crash-safety

- Size-based rotation per file: `server.log` + `server.log.1 … .11` by
  default (24 MiB each, 288 MiB cap; same for `access.log`). Tune with
  `PAPERCLIP_{SERVER,ACCESS}_LOG_MAX_{BYTES,FILES}`.
- Retention: at live-host rates measured 2026-10-22 (`server.log`
  ~10 MiB/h, `access.log` ~4 MiB/h) the defaults hold roughly 24h+ of
  `server.log` and several days of `access.log` — the hot forensics
  window. Older history is whatever the container runtime keeps:
  container stdout is unchanged, so `docker logs <container> --since …`
  on the host reaches further back, with host-managed (not
  app-managed) retention.
- Permissions: every retained file is created owner-only (`0600`), and
  newly created log directories are `0700`. Files with group/other
  permission bits (e.g. generations written before owner-only files)
  are tightened to owner-only when the sink opens them and as they
  shift through rotation; rotation itself only renames within the set,
  so it never produces a world-readable file. Files owned by another
  user cannot be tightened by the server process — the host must
  `chown`/`chmod` those back to the server user.
- Every write is a synchronous append: there is no userspace buffer to lose,
  so a hard crash (uncaught exception, OOM kill) keeps everything up to the
  final line. No `uncaughtException`/`unhandledRejection` listener is
  registered for logging, so crash behavior is unchanged.
- Newest lines are always in the un-suffixed file; `.1` is the previous
  generation. A single oversized line lands oversized rather than spinning
  rotation.
- Logging never breaks serving: an unwritable dir, disk-full, or rotation
  error degrades to stdout-only with a throttled stderr diagnostic. A
  transient reopen failure does not disable the sink: later writes retry the
  open (at most once per 5s) and logging resumes on its own.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_FILE_LOGGING` | `true` | `false`/`0`/`no`/`off` disables both files (stdout-only) |
| `PAPERCLIP_LOG_DIR` | explicit config `logging.logDir`, else instance logs dir | Directory for both files (explicit env wins) |
| `PAPERCLIP_SERVER_LOG_MAX_BYTES` | `25165824` | Rotation size for `server.log` |
| `PAPERCLIP_SERVER_LOG_MAX_FILES` | `12` | Generations kept for `server.log` |
| `PAPERCLIP_ACCESS_LOG_MAX_BYTES` | `25165824` | Rotation size for `access.log` |
| `PAPERCLIP_ACCESS_LOG_MAX_FILES` | `12` | Generations kept for `access.log` |

Sizes accept plain bytes only (`25165824`, not `10MB` or `1e9`); invalid,
suffixed, or below-floor values (minimum 64 KiB for byte caps) fall back to
defaults with a stderr warning. Unit tests run stdout-only unless they opt
in explicitly.

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

# What the server printed just before it died (oldest line first, across
# every generation the cap keeps — GNU ls version-sort on the host):
ls -rv "$LOGDIR"/server.log* 2>/dev/null | xargs cat 2>/dev/null | tail -100
```

## Rollback

Set `PAPERCLIP_FILE_LOGGING=false` and restart, or revert the change; the
files are additive only and safe to delete once the incident is closed.

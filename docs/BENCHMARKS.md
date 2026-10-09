# Local measurements

Measured 2026-10-09 on Apple M3 Pro, macOS/Darwin 25.6.0, Node v25.9.0.
The native launcher was built with Go 1.26.6. Raw results:
[benchmark.local.json](benchmark.local.json).

| Fixture | Samples | p50 | p95 |
| --- | ---: | ---: | ---: |
| In-process routing of `git status --short` | 1,000 | 0.002 ms | 0.005 ms |
| Same command through a fresh Node CLI process | 50 | 81.731 ms | 88.704 ms |
| In-process denial of `rm -rf /` | 1,000 | 0.037 ms | 0.048 ms |
| Same denial through a fresh Node CLI process | 50 | 81.080 ms | 87.761 ms |
| Native startup + resident round trip, routine command | 50 | 7.897 ms | 9.216 ms |
| Native startup + resident round trip, protected deletion | 50 | 7.459 ms | 8.550 ms |
| Real Git probe: inspect a clean-tree hard reset | 20 | 27.637 ms | 29.330 ms |

**The optional native/resident path meets the 50 ms routine p95 target on these
local fixtures.** The direct Node path still misses it. Actual host-agent
scheduling and sustained mixed-load behavior are not included.

For illustration, 100 serial routine checks at the observed native median would
add about 0.79 seconds. This is arithmetic, not a measured full-agent session.

## Method

```bash
npm run build:native
npm run bench
```

The benchmark warms in-process cases, then records 1,000 observations. Each CLI
sample starts a fresh process, supplies hook JSON on stdin, and validates the
response. Ten warmup samples are excluded, leaving 50 per fixture. The resident
measurement includes starting the Go client and its request/response round trip
to a separately running Node service. Service startup is outside that timed
section. The benchmark stops its temporary service afterward.

The filesystem and OS caches remain warm. No production agent command is
executed: the destructive strings are inputs to the checker only.

The Git fixture is a temporary repository with one committed file. Setup is
outside the timed section. Five warmup inspections are excluded, leaving 20
observations. The checker runs Git status; it never executes the submitted reset.
The temporary fixture is removed afterward.

## Limits and next measurements

The fixtures exclude agent scheduling/UI, large repository inventories, cloud
APIs, model calls, human review, and long-running mixed workloads. Rare-event
tail behavior cannot be established from these sample counts. Node CLI p95
ranged from roughly 87 to 133 ms in prior runs; the table records the final
verification run rather than selecting a best run.

Next measure end-to-end hook latency in the live agents, queueing behind Git
inspections, many targets, slow storage, and full-session overhead. The native
client holds calls when the service is unavailable or misses its deadline;
skipping required checks is not an acceptable latency optimization.

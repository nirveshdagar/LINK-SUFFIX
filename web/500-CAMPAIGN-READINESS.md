# 500-campaign production readiness

This project distinguishes two different promises:

1. **500 managed campaigns**: campaigns are saved, scheduled, and safely queued behind available browser workers and dedicated proxy ports.
2. **500 truly parallel campaigns**: all 500 campaigns own a proxy port and isolated browser worker at the same time.

The current local system supports the first promise. It does not support the second promise.

## Current measured planning result

- Saved campaign capacity: 5,000
- Requested active campaigns: 500
- Local browser workers: 20
- Dedicated gateway ports: 104
- Immediate browser campaigns: 20
- Queued campaigns: 480
- Additional workers needed for true parallel operation: 480
- Additional dedicated gateway ports needed: 396
- Hard Fleet shard minimum at 40 campaigns per shard: 13
- Conservative Fleet recommendation at 65% maximum utilization: 18 shards
- Conservative soft placement target: no more than 28 campaigns per shard

At 500 campaigns and one capture every 58 seconds, the worst-case arrival rate is:

```text
500 / 58 = 8.6207 suffix updates per second
```

With 13 shards, 40 campaigns per shard, a 50-second poll, and a 56-minute active delivery window per hour, effective theoretical capacity is:

```text
(13 * 40 / 50) * (56 / 60) = 9.7067 updates per second
```

That is mathematically stable for eventual newest-value delivery, but it runs at about 88.8% utilization. It does not meet the 65% production target and leaves insufficient failure and latency reserve. Eighteen shards reduce modeled utilization below the target.

## Required production topology for true 500-way parallel operation

- At least 500 dedicated proxy gateway ports under the current port-lock rule.
- At least 500 isolated browser worker slots distributed across multiple worker hosts.
- At least 18 Fleet shards for conservative headroom, while retaining 40 as the hard maximum campaigns per shard.
- A named HTTPS endpoint with redundant tunnel connectors or a production load balancer. A Quick Tunnel is test-only.
- Managed PostgreSQL and Redis with measured write capacity above the preflight requirement.
- Measured per-browser memory from the real destination mix.
- Measured network throughput above the estimated page-transfer rate.
- Backpressure must remain enabled so worker, port, database, or Fleet degradation queues work instead of spawning unbounded browsers.
- A 72-hour soak at target scale with forced worker loss, tunnel loss, database failover, proxy failure, and Google callback retries.

## Delivery guarantee

The Rolling Apps Script Fleet provides **newest-value eventual delivery** through leases, exact readback, acknowledgement, retry, and current-only supersession.

It cannot honestly guarantee that every intermediate 58-second capture is written to Google Ads. Any Apps Script scheduling gap, execution limit, Google-side delay, or transient failure can allow a newer capture to supersede an older pending value. The dashboard must keep these two states separate:

- Latest captured suffix
- Latest Google-verified suffix

## Preflight gate

Run the gate with Node type stripping enabled:

```powershell
node --experimental-strip-types web/scripts/capacity-preflight.mjs --mode=production
```

Available modes are `queue`, `latest`, `parallel`, `production`, and `every-capture`. A failed selected gate exits with code 2 so deployment automation can stop an unsafe rollout.

The live JSON report is available from:

```text
GET /api/capacity?campaigns=500
```

Production measurements are supplied through these environment variables:

```text
TAH_CAPACITY_TARGET
TAH_ACTIVE_CAMPAIGN_LIMIT
TAH_MAX_LOCAL_WORKERS
TAH_GATEWAY_PORT_COUNT
TAH_FLEET_SHARD_COUNT
TAH_FLEET_ACTIVE_SECONDS_PER_HOUR
TAH_MEASURED_BROWSER_MEMORY_MB
TAH_AVAILABLE_MEMORY_MB
TAH_AVAILABLE_NETWORK_MBPS
TAH_MEASURED_DATABASE_WRITES_PER_SECOND
TAH_TUNNEL_MODE=named
TAH_SOAK_TEST_HOURS
```

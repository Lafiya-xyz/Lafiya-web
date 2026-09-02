# Circuit Breaker Deployment Model for Vercel Serverless

## Decision: Per-Instance Circuit Breaker

The attestation lookup layer uses a **per-instance circuit breaker** pattern rather than a distributed (Redis-backed) circuit breaker. This document explains the rationale for this architectural decision.

## Context

The circuit breaker protects the public emergency card page from cascading failures when the Soroban RPC endpoint is degraded or unavailable. It implements the classic Release It! pattern with three states (CLOSED, OPEN, HALF-OPEN), tripping after 3 consecutive failures with a 30-second cooldown.

## Deployment Environment: Vercel Serverless Functions

Vercel's serverless execution model has the following characteristics relevant to circuit breaker design:

1. **Instance Reuse**: Vercel reuses warm serverless function instances for concurrent requests within the same region. A single instance can handle multiple requests over its lifetime.
2. **Cold Starts**: New instances are spun up on demand when traffic scales up or after inactivity.
3. **No Shared State**: Each instance has its own memory; there's no shared in-memory state across instances.
4. **Regional Distribution**: Requests are routed to the nearest region, with separate instance pools per region.

## Why Per-Instance is Sufficient

### 1. Meaningful Latency Protection

The primary goal of the circuit breaker is to **protect page render latency**, not to provide perfect coordination across all instances. A per-instance breaker achieves this:

- **Fast-fail behavior**: Each instance independently trips after 3 failures, preventing any single request from hanging on a degraded RPC endpoint.
- **Bounded latency**: OPEN state rejects requests in <100ms, ensuring the card page can still render emergency data with "verification status unavailable."
- **Cooldown protection**: The 30-second cooldown prevents instances from hammering a degraded endpoint during recovery.

### 2. Statistical Protection During Outages

During a widespread RPC outage:

- **Independent tripping**: Each instance will independently trip after 3 failed requests. With concurrent traffic, multiple instances will trip in parallel.
- **Rapid degradation**: As more instances trip, the overall system rapidly degrades to fast-fail mode across the fleet.
- **Self-healing**: Each instance independently attempts recovery after the cooldown period, allowing gradual service restoration.

### 3. Vercel's Instance Reuse Provides Coordination

Vercel's warm instance reuse provides **de facto coordination**:

- **Concurrent requests**: A warm instance handles multiple concurrent requests, so the breaker protects all those requests simultaneously.
- **Request affinity**: Requests from the same region tend to hit the same warm instances, providing regional coordination.
- **Instance lifetime**: Warm instances persist for minutes to hours, so the breaker state has meaningful duration.

### 4. Infrastructure Complexity Trade-off

Adding a distributed circuit breaker would require:

- **Redis or similar**: Introducing Redis adds infrastructure complexity, operational overhead, and cost.
- **Network latency**: Each circuit breaker check would require a network round-trip to Redis, adding latency.
- **Failure modes**: Redis itself becomes a single point of failure; if Redis is unavailable, the circuit breaker logic fails.
- **Deployment complexity**: Managing Redis in a zero-infrastructure-beyond-Supabase deployment model is disproportionate.

For a **read-only, cache-backed operation** like attestation lookup, this complexity is not justified.

### 5. Cache Layer Provides Additional Protection

The attestation layer already has multiple resilience layers:

- **Next.js unstable_cache**: Results are cached for 120s, reducing RPC call frequency.
- **Fallback memoization**: When unstable_cache is unavailable, process-local memoization provides similar protection.
- **Mock fallback**: Local dev and pre-deploy environments use an in-memory mock.

The circuit breaker is the **last line of defense**, not the primary resilience mechanism. The cache layer already reduces RPC call frequency significantly.

## When Distributed Would Be Necessary

A distributed circuit breaker would be justified if:

1. **Perfect coordination required**: If we needed to ensure that exactly one trial request is made globally during HALF-OPEN (not per-instance).
2. **Very low traffic**: If traffic is so low that instance reuse is minimal, per-instance breakers would rarely trip.
3. **Global rate limiting**: If we needed to limit RPC calls globally across all instances (not just per-instance).
4. **Complex recovery logic**: If recovery required coordination across instances (e.g., staggered recovery).

None of these apply to the attestation lookup use case.

## Conclusion

The per-instance circuit breaker provides **meaningful latency protection** for the public card page while maintaining the project's zero-infrastructure-beyond-Supabase deployment model. The statistical protection from independent instance tripping, combined with Vercel's warm instance reuse and the existing cache layer, provides sufficient resilience without the operational complexity of a distributed state store.

This decision aligns with the project's constraints and provides the required protection for the correctness- and availability-critical attestation lookup path.

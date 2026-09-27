import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 2048;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const ROUTE_CLASSES = ['card', 'profile', 'auth', 'marketing'] as const;
const METRICS = ['LCP', 'INP', 'CLS', 'TTFB'] as const;
const CONNECTION_TYPES = ['slow-2g', '2g', '3g', '4g'] as const;
const MEMORY_BUCKETS = ['low', 'mid', 'high'] as const;

type RouteClass = (typeof ROUTE_CLASSES)[number];
type Metric = (typeof METRICS)[number];
type ConnectionType = (typeof CONNECTION_TYPES)[number];
type MemoryBucket = (typeof MEMORY_BUCKETS)[number];

interface VitalsPayload {
  routeClass: RouteClass;
  metric: Metric;
  value: number;
  connection: ConnectionType | 'unknown';
  memory: MemoryBucket | 'unknown';
}

interface AggregationBucket {
  day: string;
  routeClass: RouteClass;
  metric: Metric;
  samples: number[];
}

const rateLimitStore = new Map<string, number[]>();
const aggregationStore = new Map<string, AggregationBucket>();

function isRouteClass(value: unknown): value is RouteClass {
  return typeof value === 'string' && (ROUTE_CLASSES as readonly string[]).includes(value);
}

function isMetric(value: unknown): value is Metric {
  return typeof value === 'string' && (METRICS as readonly string[]).includes(value);
}

function isConnectionType(value: unknown): value is ConnectionType | 'unknown' {
  return value === 'unknown' || (typeof value === 'string' && (CONNECTION_TYPES as readonly string[]).includes(value));
}

function isMemoryBucket(value: unknown): value is MemoryBucket | 'unknown' {
  return value === 'unknown' || (typeof value === 'string' && (MEMORY_BUCKETS as readonly string[]).includes(value));
}

function parsePayload(raw: unknown): VitalsPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!isRouteClass(candidate.routeClass)) return null;
  if (!isMetric(candidate.metric)) return null;
  if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value) || candidate.value < 0) return null;
  if (!isConnectionType(candidate.connection)) return null;
  if (!isMemoryBucket(candidate.memory)) return null;
  return {
    routeClass: candidate.routeClass,
    metric: candidate.metric,
    value: candidate.value,
    connection: candidate.connection,
    memory: candidate.memory,
  };
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitStore.get(key) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(key, recent);
    return true;
  }
  recent.push(now);
  rateLimitStore.set(key, recent);
  return false;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function recordSample(payload: VitalsPayload): void {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}:${payload.routeClass}:${payload.metric}`;
  const bucket = aggregationStore.get(key) ?? {
    day,
    routeClass: payload.routeClass,
    metric: payload.metric,
    samples: [],
  };
  bucket.samples.push(payload.value);
  aggregationStore.set(key, bucket);
}

function p75ByRouteClass(): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const bucket of aggregationStore.values()) {
    result[bucket.routeClass] = result[bucket.routeClass] ?? {};
    result[bucket.routeClass][bucket.metric] = percentile(bucket.samples, 75);
  }
  return result;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'payload too large' }, { status: 413 });
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const payload = parsePayload(raw);
  if (!payload) {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  recordSample(payload);
  return new NextResponse(null, { status: 204 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ p75: p75ByRouteClass() });
}

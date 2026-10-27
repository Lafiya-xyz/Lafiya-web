/**
 * Strict QR payload and URL validator
 * Mitigates open redirects, SSRF, and malicious scheme injection.
 */

export interface QrValidationResult {
  isValidLafiyaUrl: boolean;
  safeUrl: string | null;
  path: string | null;
  rawText: string;
  error?: 'malformed_url' | 'untrusted_origin' | 'invalid_path' | 'unsafe_protocol';
}

const ALLOWED_HOSTS = new Set([
  'lafiya.net',
  'www.lafiya.net',
  'app.lafiya.net',
  'localhost',
  '127.0.0.1',
]);

const ALLOWED_CARD_PATH_PREFIXES = [
  '/card/',
  '/c/',
];

export function validateQrPayload(rawPayload: string): QrValidationResult {
  const trimmed = rawPayload.trim();

  // If payload does not look like a URL with http/https scheme, treat safely as text
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      isValidLafiyaUrl: false,
      safeUrl: null,
      path: null,
      rawText: trimmed,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isValidLafiyaUrl: false,
      safeUrl: null,
      path: null,
      rawText: trimmed,
      error: 'malformed_url',
    };
  }

  // 1. Enforce safe protocol
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      isValidLafiyaUrl: false,
      safeUrl: null,
      path: null,
      rawText: trimmed,
      error: 'unsafe_protocol',
    };
  }

  // 2. Strict origin check (prevent SSRF and open redirect)
  const hostname = parsed.hostname.toLowerCase();
  const isAllowedHost =
    ALLOWED_HOSTS.has(hostname) ||
    hostname.endsWith('.lafiya.net') ||
    hostname.endsWith('.preview.lafiya.net');

  if (!isAllowedHost) {
    return {
      isValidLafiyaUrl: false,
      safeUrl: null,
      path: null,
      rawText: trimmed,
      error: 'untrusted_origin',
    };
  }

  // 3. Strict path prefix check (only emergency card routes)
  const isAllowedPath = ALLOWED_CARD_PATH_PREFIXES.some((prefix) =>
    parsed.pathname.startsWith(prefix)
  );

  if (!isAllowedPath) {
    return {
      isValidLafiyaUrl: false,
      safeUrl: null,
      path: null,
      rawText: trimmed,
      error: 'invalid_path',
    };
  }

  return {
    isValidLafiyaUrl: true,
    safeUrl: parsed.origin + parsed.pathname,
    path: parsed.pathname,
    rawText: trimmed,
  };
}

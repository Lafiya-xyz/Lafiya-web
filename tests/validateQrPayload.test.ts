import { describe, it, expect } from 'vitest';
import { validateQrPayload } from '../lib/qr/validateQrPayload';

describe('validateQrPayload', () => {
  it('accepts valid https Lafiya card URLs', () => {
    const res = validateQrPayload('https://lafiya.net/card/card_123456');
    expect(res.isValidLafiyaUrl).toBe(true);
    expect(res.path).toBe('/card/card_123456');
    expect(res.safeUrl).toBe('https://lafiya.net/card/card_123456');
  });

  it('accepts valid short links', () => {
    const res = validateQrPayload('https://app.lafiya.net/c/abcXYZ');
    expect(res.isValidLafiyaUrl).toBe(true);
    expect(res.path).toBe('/c/abcXYZ');
  });

  it('rejects external phishing or open redirect domains', () => {
    const res = validateQrPayload('https://evil-phishing.com/card/card_123456');
    expect(res.isValidLafiyaUrl).toBe(false);
    expect(res.error).toBe('untrusted_origin');
  });

  it('rejects disallowed path structures to prevent SSRF', () => {
    const res = validateQrPayload('https://lafiya.net/api/internal/secret');
    expect(res.isValidLafiyaUrl).toBe(false);
    expect(res.error).toBe('invalid_path');
  });

  it('safely handles non-URL text payloads without throwing', () => {
    const res = validateQrPayload('Patient Blood Type: O+, Allergy: Penicillin');
    expect(res.isValidLafiyaUrl).toBe(false);
    expect(res.rawText).toBe('Patient Blood Type: O+, Allergy: Penicillin');
    expect(res.safeUrl).toBeNull();
  });
});

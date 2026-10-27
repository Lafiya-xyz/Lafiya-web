import { describe, it, expect } from 'vitest';
import { parseCameraError, getTorchController } from '../lib/camera/camera-controls';

describe('parseCameraError', () => {
  it('identifies NotAllowedError as permission_denied', () => {
    const domErr = new DOMException('Permission denied', 'NotAllowedError');
    const parsed = parseCameraError(domErr);
    expect(parsed.type).toBe('permission_denied');
    expect(parsed.canRetry).toBe(true);
    expect(parsed.userMessage).toContain('permission was denied');
  });

  it('identifies NotFoundError as device_not_found', () => {
    const domErr = new DOMException('No camera', 'NotFoundError');
    const parsed = parseCameraError(domErr);
    expect(parsed.type).toBe('device_not_found');
    expect(parsed.canRetry).toBe(false);
  });

  it('handles standard Error gracefully', () => {
    const err = new Error('Generic failure');
    const parsed = parseCameraError(err);
    expect(parsed.type).toBe('unknown');
    expect(parsed.userMessage).toBe('Generic failure');
  });
});

describe('getTorchController', () => {
  it('returns unsupported when stream is null', async () => {
    const torch = getTorchController(null);
    expect(torch.isSupported).toBe(false);
    expect(torch.isOn).toBe(false);
    expect(await torch.toggle()).toBe(false);
  });
});

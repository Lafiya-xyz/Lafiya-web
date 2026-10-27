/**
 * Camera permissions handler and hardware torch controller
 */

export interface CameraErrorDetails {
  type: 'permission_denied' | 'device_not_found' | 'in_use' | 'unsupported' | 'unknown';
  userMessage: string;
  canRetry: boolean;
}

export function parseCameraError(error: unknown): CameraErrorDetails {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return {
          type: 'permission_denied',
          userMessage: 'Camera permission was denied. Please allow camera access in browser settings.',
          canRetry: true,
        };
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return {
          type: 'device_not_found',
          userMessage: 'No compatible camera found on this device.',
          canRetry: false,
        };
      case 'NotReadableError':
      case 'TrackStartError':
        return {
          type: 'in_use',
          userMessage: 'Camera is currently in use by another application.',
          canRetry: true,
        };
      case 'OverconstrainedError':
        return {
          type: 'unsupported',
          userMessage: 'Requested camera constraints are not supported by the hardware.',
          canRetry: true,
        };
      default:
        break;
    }
  }

  const message = error instanceof Error ? error.message : 'Unknown camera initialization failure.';
  return {
    type: 'unknown',
    userMessage: message,
    canRetry: true,
  };
}

export interface TorchSupport {
  isSupported: boolean;
  isOn: boolean;
  toggle: () => Promise<boolean>;
}

export function getTorchController(stream: MediaStream | null): TorchSupport {
  if (!stream) {
    return { isSupported: false, isOn: false, toggle: async () => false };
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    return { isSupported: false, isOn: false, toggle: async () => false };
  }

  // Check if track supports torch capability
  const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
  const isSupported = Boolean(capabilities && 'torch' in capabilities && (capabilities as Record<string, unknown>).torch);

  let torchState = false;

  const toggle = async (): Promise<boolean> => {
    if (!isSupported) return false;
    try {
      torchState = !torchState;
      await (track as any).applyConstraints({
        advanced: [{ torch: torchState }],
      });
      return torchState;
    } catch {
      torchState = false;
      return false;
    }
  };

  return {
    isSupported,
    get isOn() {
      return torchState;
    },
    toggle,
  };
}

import { describe, it, expect, vi } from 'vitest';
import { redirect } from 'next/navigation';
import { signUp } from '@/app/(auth)/signup/actions';

// Mock supabase client. mockSignUp is hoisted and shared so tests can
// configure its return value before calling signUp() and have that
// configuration actually apply to the call the action makes internally —
// createClient() must always return the SAME signUp mock instance, not a
// fresh vi.fn() per invocation.
const mockSignUp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: {
      signUp: mockSignUp,
    },
  })),
}));

// signUp also writes a consent_logs row via the admin (service-role) client.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    }),
    auth: {
      admin: {
        deleteUser: vi.fn(),
      },
    },
  })),
}));

// Mock redirect
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

describe('signUp server action', () => {
  it('rejects invalid email and password', async () => {
    const formData = new FormData();
    formData.set('email', 'invalid-email');
    formData.set('password', 'short');
    const result = await signUp(undefined, formData);
    expect(result?.error).toBe('Enter a valid email address');
  });

  it('redirects on successful sign‑up with session', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: {} as never },
      error: null,
    });
    const formData = new FormData();
    formData.set('email', 'user@example.com');
    formData.set('password', 'validPassword123');
    formData.set('consent', 'on');
    const result = await signUp(undefined, formData);
    expect(result).toBeUndefined();
    expect(redirect).toHaveBeenCalledWith('/profile');
  });

  it('returns info when sign‑up succeeds without session', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    });
    const formData = new FormData();
    formData.set('email', 'user2@example.com');
    formData.set('password', 'validPassword123');
    formData.set('consent', 'on');
    const result = await signUp(undefined, formData);
    expect(result?.info).toBe('Check your email to confirm your account, then sign in.');
    expect(redirect).not.toHaveBeenCalled();
  });
});

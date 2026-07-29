import { describe, it, expect, vi } from 'vitest';
import { upsertProfile } from '@/app/(auth)/profile/actions';

vi.mock('@/lib/supabase/server', () => {
  return {
    createClient: vi.fn().mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: { id: 'test-user' } } }),
      },
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
});

describe('upsertProfile validation', () => {
  it('returns fieldErrors for multiple invalid fields', async () => {
    const formData = new FormData();
    // upsertProfile requires a concurrency token on every save; the mocked
    // `existing` row is null, so any non-empty value satisfies the check.
    formData.set('expectedUpdatedAt', 'test-token');
    formData.set('name', ''); // empty name triggers required
    formData.set('dateOfBirth', 'not-a-date'); // invalid date
    formData.set('bloodGroup', 'unknown');
    formData.set('genotype', 'unknown');
    // required array fields can be empty: omitted entirely, matching how
    // getTagList/getAll naturally return [] for a field never set.
    formData.set('emergencyContactsJson', '[]');

    const result = await upsertProfile(undefined, formData);
    expect(result.errors).toBeDefined();
    expect(result.errors?.['name']).toBe('Name is required');
    expect(result.errors?.['dateOfBirth']).toBe('Enter a valid date');
  });
});

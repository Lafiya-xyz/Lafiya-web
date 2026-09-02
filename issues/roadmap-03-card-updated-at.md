# Show the public card’s last-updated timestamp with an explicit freshness label

## Category

Good First

## Summary

Expose a safe `updated_at` value in the emergency-card RPC and render it as a clear “Updated” timestamp on the public card.

## Current Behavior

`get_emergency_card` in `supabase/migrations/20260709110953_emergency_card_rpc.sql` returns the emergency subset but omits `profiles.updated_at`. `app/(public)/card/[id]/page.tsx` shows data and an offline cached-data banner, but no online record timestamp.

## Problem

A responder cannot distinguish a recently maintained card from an old live record when the network is available.

## Why This Matters

Freshness context helps responders make safer decisions and complements the service worker’s explicit offline timestamp.

## Proposed Scope

Add `updated_at` to the RPC return type and hand-authored types, render a localized accessible timestamp, and ensure the value is not confused with attestation time or offline cache time.

## Acceptance Criteria

- [ ] RPC returns only the card’s `updated_at` in addition to the existing projection.
- [ ] Public card renders the timestamp with an accessible label.
- [ ] Offline cached rendering preserves the existing cached-at warning.
- [ ] Integration contract tests verify the new column is intentional.

## Technical Considerations

Use the existing `profiles_set_updated_at` trigger. Do not expose `user_id`, consent data, profile secrets, or internal timestamps beyond the intended update value.

## Testing Requirements

Test RPC shape, display formatting, and coexistence of live and offline freshness indicators.

## Cross-Repository Impact

The emergency-card projection is a shared product contract documented in `lafiya-docs`; coordinate the additive field there if that schema is mirrored.

## Out of Scope

Changing cache TTLs, attestation timestamps, or adding access analytics.

## Complexity

Good First — additive migration/type/UI change with established tests.

## Impact

Medium — improves responder context on the core product surface.

## Suggested Labels

`good-first-issue`, `emergency-card`, `accessibility`

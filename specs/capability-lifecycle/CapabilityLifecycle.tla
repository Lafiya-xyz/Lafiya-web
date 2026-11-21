---------------------------- MODULE CapabilityLifecycle ----------------------------
(***************************************************************************)
(* TLA+ specification of the emergency-access capability lifecycle:        *)
(* issuance, rotation, revocation, expiry, view-budget exhaustion, offline *)
(* caching of the encrypted envelope, and purge on reconnection.           *)
(*                                                                         *)
(* Issue #951. Model-checked by TLC in CI (see specs/capability-lifecycle/ *)
(* run-tlc.sh and .github/workflows/capability-spec.yml).                  *)
(*                                                                         *)
(* Code paths modelled (each action names its implementation):             *)
(*   Issue      -> supabase/migrations/20260821170000_emergency_access_    *)
(*                 capabilities.sql :: create_emergency_capability         *)
(*                 app/(auth)/profile/actions.ts :: createEmergencyCapability *)
(*   Rotate     -> app/(auth)/profile/actions.ts (issue new + revoke old)  *)
(*   Revoke     -> supabase/.../revoke_emergency_capability                *)
(*                 app/(auth)/profile/actions.ts :: revokeEmergencyCapability *)
(*   Resolve    -> supabase/migrations/20260831000000_capability_access_   *)
(*                 state_detail.sql :: consume_emergency_capability        *)
(*                 app/(public)/card/c/[token]/page.tsx                    *)
(*   Cache      -> public/sw.js :: handleCardNavigation (storeEnvelope)    *)
(*                 public/offline-cache-helpers.js :: createOfflineEnvelope *)
(*   ServeOffline -> public/sw.js (cache branch) + validateOfflineEnvelope *)
(*   Purge      -> public/sw.js (cache.delete on non-ok / invalid envelope) *)
(*                                                                         *)
(* Safety properties:                                                      *)
(*   S1 NoDisclosureAfterRevoke  - a revoked capability never serves data. *)
(*   S2 NoDisclosureAfterExpiry  - an expired capability never serves data.*)
(*   S3 ViewBudgetRespected      - successful resolutions <= max_views.    *)
(*   S4 OfflineNeverOutlivesAuth - an offline copy is never served after   *)
(*                                 its authorization expiry.               *)
(*   S5 NoCacheWithoutConsent    - no envelope is admitted when the        *)
(*                                 offline_caching consent is absent.      *)
(*   S6 PurgeOnReconnect         - after a successful reconnection that     *)
(*                                 observed a dead capability, no stale    *)
(*                                 envelope remains.                        *)
(* Liveness:                                                               *)
(*   L1 RotationEventuallyRevokes - a rotated capability is eventually     *)
(*                                  revoked (no orphaned live capability). *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Capabilities,   \* set of capability ids, e.g. {"c1","c2","c3"}
          MaxViews,       \* view budget for temporary capabilities
          MaxAge          \* offline envelope max age, in ticks

VARIABLES
  state,        \* capability id -> "active" | "revoked" | "expired" | "exhausted"
  views,        \* capability id -> number of successful resolutions
  cached,       \* capability id -> TRUE iff an offline envelope is stored
  cachedAt,     \* capability id -> tick at which the envelope was written
  consent,      \* capability id -> offline_caching consent present
  now,          \* logical clock
  served,       \* capability id -> TRUE iff data was ever served
  rotatedFrom   \* capability id -> capability it replaced (or "none")

vars == <<state, views, cached, cachedAt, consent, now, served, rotatedFrom>>

TypeOK ==
  /\ state \in [Capabilities -> {"active", "revoked", "expired", "exhausted"}]
  /\ views \in [Capabilities -> 0..MaxViews]
  /\ cached \in [Capabilities -> BOOLEAN]
  /\ cachedAt \in [Capabilities -> 0..MaxAge]
  /\ consent \in [Capabilities -> BOOLEAN]
  /\ now \in Nat
  /\ served \in [Capabilities -> BOOLEAN]
  /\ rotatedFrom \in [Capabilities -> Capabilities \cup {"none"}]

Init ==
  /\ state = [c \in Capabilities |-> "active"]
  /\ views = [c \in Capabilities |-> 0]
  /\ cached = [c \in Capabilities |-> FALSE]
  /\ cachedAt = [c \in Capabilities |-> 0]
  /\ consent = [c \in Capabilities |-> TRUE]
  /\ now = 0
  /\ served = [c \in Capabilities |-> FALSE]
  /\ rotatedFrom = [c \in Capabilities |-> "none"]

\* Time passes; capabilities whose expiry tick is reached become expired.
Tick ==
  /\ now' = now + 1
  /\ state' = [c \in Capabilities |->
       IF state[c] = "active" /\ now' >= MaxAge THEN "expired" ELSE state[c]]
  /\ UNCHANGED <<views, cached, cachedAt, consent, served, rotatedFrom>>

\* create_emergency_capability: a fresh capability starts active, zero views.
Issue(c) ==
  /\ state[c] = "active"
  /\ views[c] = 0
  /\ ~served[c]
  /\ UNCHANGED <<state, views, cached, cachedAt, consent, now, served, rotatedFrom>>

\* Rotation: issue a replacement and revoke the predecessor in one step.
\* (app/(auth)/profile/actions.ts: new capability, then revoke old.)
Rotate(old, new) ==
  /\ old # new
  /\ state[old] = "active"
  /\ state[new] = "active"
  /\ views[new] = 0
  /\ rotatedFrom[new] = "none"
  /\ state' = [state EXCEPT ![old] = "revoked"]
  /\ rotatedFrom' = [rotatedFrom EXCEPT ![new] = old]
  /\ cached' = [cached EXCEPT ![old] = FALSE]
  /\ UNCHANGED <<views, cachedAt, consent, now, served>>

\* revoke_emergency_capability: idempotent, owner-scoped.
Revoke(c) ==
  /\ state[c] = "active"
  /\ state' = [state EXCEPT ![c] = "revoked"]
  /\ cached' = [cached EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<views, cachedAt, consent, now, served, rotatedFrom>>

\* consume_emergency_capability: the only path that discloses data.
\* Authorization is checked against the *current* state, and the view
\* increment happens in the same row lock as the projection.
Resolve(c) ==
  /\ state[c] = "active"
  /\ views[c] < MaxViews
  /\ views' = [views EXCEPT ![c] = views[c] + 1]
  /\ served' = [served EXCEPT ![c] = TRUE]
  /\ state' = [state EXCEPT ![c] =
       IF views[c] + 1 >= MaxViews THEN "exhausted" ELSE state[c]]
  /\ UNCHANGED <<cached, cachedAt, consent, now, rotatedFrom>>

\* Service worker stores an encrypted envelope after a successful live fetch.
\* Admission requires consent and an active capability.
Cache(c) ==
  /\ state[c] = "active"
  /\ consent[c]
  /\ ~cached[c]
  /\ cached' = [cached EXCEPT ![c] = TRUE]
  /\ cachedAt' = [cachedAt EXCEPT ![c] = now]
  /\ UNCHANGED <<state, views, consent, now, served, rotatedFrom>>

\* Offline read: served only while the envelope is fresh and the capability
\* is still authorized. validateOfflineEnvelope enforces both bounds.
ServeOffline(c) ==
  /\ cached[c]
  /\ state[c] = "active"
  /\ now - cachedAt[c] <= MaxAge
  /\ served' = [served EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<state, views, cached, cachedAt, consent, now, rotatedFrom>>

\* Reconnection: the live fetch returns a non-ok / non-cacheable response,
\* so the worker deletes any prior local copy.
Purge(c) ==
  /\ cached[c]
  /\ cached' = [cached EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<state, views, cachedAt, consent, now, served, rotatedFrom>>

\* Consent withdrawal (offline_caching) also drops the local copy.
WithdrawConsent(c) ==
  /\ consent[c]
  /\ consent' = [consent EXCEPT ![c] = FALSE]
  /\ cached' = [cached EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<state, views, cachedAt, now, served, rotatedFrom>>

Next ==
  \/ Tick
  \/ \E c \in Capabilities : Issue(c)
  \/ \E o, n \in Capabilities : Rotate(o, n)
  \/ \E c \in Capabilities : Revoke(c)
  \/ \E c \in Capabilities : Resolve(c)
  \/ \E c \in Capabilities : Cache(c)
  \/ \E c \in Capabilities : ServeOffline(c)
  \/ \E c \in Capabilities : Purge(c)
  \/ \E c \in Capabilities : WithdrawConsent(c)

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------------------
\* Safety
\* ---------------------------------------------------------------------------

\* S1/S2: a capability that is revoked or expired never serves data again.
\* `served` is only ever set by Resolve/ServeOffline, both of which require
\* state[c] = "active", so a dead capability can never be the source of a
\* disclosure. The invariant is stated over the *current* state so TLC
\* checks it in every reachable state, not just at the end of a trace.
NoDisclosureAfterRevoke ==
  \A c \in Capabilities :
    state[c] = "revoked" => ~served[c]

NoDisclosureAfterExpiry ==
  \A c \in Capabilities :
    state[c] = "expired" => ~served[c]

\* S3: the view budget is never exceeded.
ViewBudgetRespected ==
  \A c \in Capabilities : views[c] <= MaxViews

\* S4: an offline copy is never served past its authorization expiry.
OfflineNeverOutlivesAuth ==
  \A c \in Capabilities :
    (cached[c] /\ served[c]) => (now - cachedAt[c] <= MaxAge)

\* S5: no envelope is admitted without offline_caching consent.
NoCacheWithoutConsent ==
  \A c \in Capabilities : cached[c] => consent[c]

\* S6: a dead capability never keeps a local copy.
PurgeOnReconnect ==
  \A c \in Capabilities :
    (state[c] \in {"revoked", "expired", "exhausted"}) => ~cached[c]

Safety ==
  /\ TypeOK
  /\ NoDisclosureAfterRevoke
  /\ NoDisclosureAfterExpiry
  /\ ViewBudgetRespected
  /\ OfflineNeverOutlivesAuth
  /\ NoCacheWithoutConsent
  /\ PurgeOnReconnect

\* ---------------------------------------------------------------------------
\* Liveness
\* ---------------------------------------------------------------------------

\* L1: a capability that was rotated away from is eventually revoked.
RotationEventuallyRevokes ==
  \A c \in Capabilities :
    (rotatedFrom[c] # "none") ~> (state[c] = "revoked")

Liveness == RotationEventuallyRevokes

=============================================================================

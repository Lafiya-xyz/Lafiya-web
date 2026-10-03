# Spike: SMS/USSD Emergency-Card Lookup Channel (#536)

**Status:** Spike complete — recommendation is conditional go, gated on items
under [Go/no-go criteria](#gonogo-criteria).
**Author:** implementation spike, 2026-09-29.
**Scope:** Evaluate an SMS short-code or USSD flow so a responder without
mobile data can text/dial a code printed on a Lafiya card and receive the
critical emergency subset (blood group, genotype, allergies). This document
does not change any code; it is the design and risk record required before
building the channel.

## 1. Why this is a genuinely different problem from the web capability

The existing `/card/c/<capability>` flow (`lib/emergency/capability.ts`,
`docs/adr-003-emergency-access-capabilities.md`) already solves "bounded,
revocable, digest-only-at-rest access to a critical field subset" for a
browser bearer link. SMS/USSD reuses that trust model but changes the
transport in ways that break several of its safety assumptions:

- The web capability is a 256-bit random token (`lafiya_e1_<43 base64url
  chars>`, see `CAPABILITY_PREFIX` / `CAPABILITY_TOKEN_PATTERN` in
  `lib/emergency/capability.ts`) carried in a URL. A responder cannot
  reliably type 43 mixed-case characters into a phone keypad under
  emergency stress, and GSM SMS/USSD is not a URL transport.
  **A short-code cannot be the same secret as the capability token; it has
  to be a distinct, shorter, separately-scoped credential** — this is
  called out explicitly in the issue and is the central design constraint
  below.
- SMS is delivered and stored in plaintext through the carrier's SMSC and,
  for the sender, through the aggregator's platform. USSD is not stored by
  the handset but the session still transits the carrier's USSD gateway
  in plaintext. Neither channel gets Lafiya's existing TLS-to-browser or
  `Cache-Control: private, no-store` guarantees. This spike's threat model
  (§5) treats "the carrier and aggregator can read the request and
  response" as a given, not an edge case.
- Web capability resolution is stateless HTTP the browser initiates
  directly against Lafiya. SMS/USSD both route through a paid
  third-party aggregator, which is a new dependency, a new party with
  visibility into request metadata, and a new cost per lookup.

## 2. Aggregator survey (Africa's Talking, Termii)

**This section is a desk survey from public product documentation and
general vendor knowledge as of this spike's writing (2026-09-29), not a
live commercial quote.** Aggregator pricing and session terms change
frequently and are negotiated per account/volume; before committing to a
vendor, Lafiya must request a current rate card and confirm short-code/USSD
code leasing terms directly. Nothing below should be read as a locked-in
price or SLA.

### 2.1 Africa's Talking

- **Coverage/model:** Pan-African aggregator (strong in Kenya, Nigeria,
  Uganda, Rwanda, others) offering USSD, SMS, Voice, and Airtime APIs
  under one account. Nigeria USSD requires leasing a shared or dedicated
  USSD code (e.g. `*XXX#` or a shared code with a sub-menu string) through
  Africa's Talking's Nigerian telco relationships (MTN, Airtel, Glo, 9mobile).
- **USSD session model:** Classic USSD push/pull session — the carrier
  POSTs each keypress to a webhook Lafiya hosts, with a session ID, and
  Lafiya responds with `CON` (continue, show another menu) or `END`
  (terminate, show final text). Session length is carrier-bounded, typically
  ~15–180 seconds of inactivity timeout depending on network, which is a
  hard constraint on how many menu hops a lookup flow can have.
- **Cost shape:** Africa's Talking's public model has historically been
  pay-per-session for USSD (a small fee per session regardless of hops) plus
  a recurring or one-time short-code/service-code lease fee, and separate
  per-SMS pricing for the SMS API. Exact Naira figures are account- and
  volume-negotiated and not something this spike can state as fact; they
  must be pulled from a live sales/API quote before a go decision.
- **Latency:** USSD session round-trips are typically sub-second to a few
  seconds per hop in normal conditions, since the responder is in an
  active telco session; end-to-end responsiveness is much more dependent on
  Lafiya's webhook latency than on the aggregator, because the carrier
  enforces a tight per-hop timeout and will drop the session if Lafiya's
  webhook is slow.
- **Fit for this use case:** Reasonable fit. Africa's Talking's USSD model
  supports a single-hop "dial code, get text back" flow (`*384*label#`
  style), which matches "responder dials, gets critical fields, done."

### 2.2 Termii

- **Coverage/model:** Nigeria-focused (with growing regional coverage)
  communications platform: SMS, Voice, WhatsApp, Email, and a Switch/USSD
  offering. Termii's identity/OTP-oriented SMS product is well known in the
  Nigerian fintech space; its USSD product is comparatively newer and would
  need direct confirmation of current session-webhook contract shape and
  Nigerian carrier reach (MTN/Airtel/Glo/9mobile) before relying on it.
- **USSD session model:** Similar webhook-driven session model to Africa's
  Talking in concept (carrier calls Termii, Termii calls Lafiya's webhook,
  Lafiya returns text, session continues or ends), but the exact
  request/response schema differs and must be read from Termii's current
  API reference at integration time, not assumed from this spike.
- **Cost shape:** Termii's SMS pricing is well documented in Naira-per-unit
  terms for the Nigerian market and is typically competitive for
  transactional SMS; USSD/short-code leasing costs are a separate,
  Nigeria-specific negotiation. As with Africa's Talking, this spike does
  not have a current rate card and one must be requested before a go
  decision.
- **Fit for this use case:** Reasonable fit, and possibly a better default
  given Termii's Nigeria-first focus (Lafiya's stated market), but the USSD
  product is the less battle-tested of the two, so the sandbox validation
  in §7 should test USSD session stability on Termii specifically, not just
  assume parity with Africa's Talking.

### 2.3 Recommendation from the survey

Do not pick a single vendor from this desk research. Both aggregators are
credible, both require a Nigerian short-code/USSD-code lease (a recurring
cost and a several-week carrier approval process is typical for USSD code
provisioning across all aggregators, not just these two), and the real
differentiators are things only a live sandbox test can answer: actual
session timeout behavior under Lafiya's expected webhook latency, actual
current pricing, and actual SMS delivery latency to Nigerian carriers. Both
should go into the sandbox validation step in §7 before a vendor is chosen.

## 3. Short-code capability design

### 3.1 Why it must not be the main card token

`lib/emergency/capability.ts` defines the web bearer credential as:

```ts
export const CAPABILITY_PREFIX = "lafiya_e1_";
export const CAPABILITY_TOKEN_PATTERN = /^lafiya_e1_[A-Za-z0-9_-]{43}$/;
```

That is 256 bits of entropy, base64url-encoded — correct for a URL a phone
camera scans, wrong for a string a stressed responder types on a T9 keypad
or reads off a small card font over the phone. Reusing it for SMS/USSD would
also mean the same secret that unlocks the *unlimited-view "emergency"
purpose* capability (per the `emergency_capabilities` table's
`purpose = 'emergency' and max_views is null` constraint) is now also
transiting carrier SMSCs and aggregator logs in plaintext on every lookup —
that is an unacceptable entropy-to-exposure trade for the highest-privilege
credential Lafiya issues. The short-code must be a **separate, lower-value,
independently-revocable credential**, structurally incapable of being
upgraded into the full capability.

### 3.2 Proposed format

```
LAF-XXXXXX
```

- 6 alphanumeric characters drawn from a 32-symbol Crockford-style alphabet
  that excludes visually ambiguous characters (`0/O`, `1/I/L`, and vowels
  removed to also avoid accidental real words): alphabet
  `23456789ABCDEFGHJKMNPQRSTVWXYZ`. That gives `32^6 ≈ 1.07 × 10^9`
  possible codes — enough keyspace to make blind guessing impractical when
  combined with rate limiting (§3.4), while staying short enough to read
  off a card and type on a keypad or speak over a phone call.
- `LAF-` prefix is fixed and does not consume entropy from the guessable
  space (same reasoning as `lafiya_e1_` on the web token: it versions the
  protocol, it is not a secret).
- Persisted the same way as the existing capability: **never store the raw
  code**, only `sha256(LAF-XXXXXX)` in a new `sms_lookup_codes` table (or a
  new `purpose` value if reusing `emergency_capabilities`'s shape — see
  §3.5 for why a separate table is preferred).

### 3.3 Entropy analysis and why 6 characters is the right size here

- 1.07B possible codes total is far below the 256-bit web token, by design
  — it has to be, to be human-typeable. The security property this design
  leans on instead is **short validity window + strict rate limiting +
  narrow scope**, not raw keyspace, exactly the same trade USSD banking PINs
  and OTPs make (typically 4–6 digits) for the same human-input constraint.
- Compare to a 6-digit numeric OTP (10^6 = 1,000,000 space): this design's
  32-symbol, 6-char alphabet is roughly 1000x larger than a 6-digit PIN
  space, while still being one visual token a person can read off a printed
  card.
- Because short-code lookups return **less** than the full emergency
  capability payload (see §4 minimal payload), the value of a successfully
  guessed code is bounded even before rate limiting is considered.

### 3.4 Rate limiting (the load-bearing control, given the smaller keyspace)

Multiple independent limits, all enforced server-side at the webhook
Lafiya's Next.js API route exposes to the aggregator (not just at the
aggregator, which Lafiya does not control):

1. **Per-code limiter:** a given `LAF-XXXXXX` code may be resolved at most
   N times (recommend N=20, matching the existing `temporary` capability's
   `max_views between 1 and 20` ceiling) before it auto-revokes, independent
   of time.
2. **Per-code time-to-live:** short-code lookups are meant for one incident,
   not a standing credential — recommend a default 24-hour expiry from
   issuance, patient-configurable up to 7 days, deliberately shorter than
   the `temporary` web capability's 30-day ceiling because the exposure
   channel is worse.
3. **Global per-source-MSISDN limiter:** the aggregator webhook payload
   includes the responder's phone number (MSISDN) for USSD sessions and the
   sender number for inbound SMS. Rate-limit lookups per source MSISDN
   (recommend 5/hour, 20/day) to blunt automated enumeration from a single
   number.
4. **Global per-account limiter:** a system-wide cap on total short-code
   resolutions per minute, as a circuit breaker against a compromised or
   spoofed aggregator webhook hammering the endpoint.
5. **Progressive lockout on the per-code limiter:** after 3 failed
   (unknown/expired/exhausted) lookups against the *same* code value within
   a short window, that code value is logged for review and further
   attempts return the generic "no data" response with an added artificial
   delay, mirroring how the existing capability resolver already returns
   "the same no-data public result" for revoked/expired/exhausted/malformed
   /unknown capabilities (ADR-003 §Decision) — the SMS/USSD path must
   preserve that non-distinguishing-response property, since telling an
   attacker "wrong code" vs. "no such code" is itself a leak.

### 3.5 Data model sketch (additive, not a replacement)

Prefer a **new** table, `sms_lookup_codes`, rather than overloading
`emergency_capabilities.purpose`, because the short-code has a genuinely
different shape (short human-typeable secret, MSISDN-scoped rate limiting,
much smaller field set) and conflating it with the existing purpose enum's
`emergency`/`temporary` invariants (`max_views` nullability tied to purpose,
180-day ceiling, etc., enforced in
`supabase/migrations/20260821170000_emergency_access_capabilities.sql`)
would weaken those invariants for the web path too. Sketch:

```sql
create table public.sms_lookup_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_digest text not null unique check (code_digest ~ '^[0-9a-f]{64}$'),
  field_allowlist jsonb not null, -- must be a subset of the SMS minimal set, see §4
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_resolutions integer not null check (max_resolutions between 1 and 20),
  used_resolutions integer not null default 0 check (used_resolutions >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
```

Resolution events (source MSISDN, outcome, timestamp — never the raw code,
never full patient content) should log to a table parallel to
`card_access_events`, with the same "coarse outcome only" discipline ADR-003
already established, plus the source MSISDN's carrier (derivable from the
MSISDN prefix) for rate-limit auditing, but not the full MSISDN retained
long-term (see §5.2 on carrier logging / SIM swap — Lafiya should not become
a second copy of "who texted about whom" longer than operationally needed
for abuse response, currently proposed at the same 90-day retention ADR-003
uses for card access events).

## 4. Minimal SMS payload and patient opt-in

### 4.1 Minimal response payload

The issue's proposed critical subset is blood group, genotype, allergies.
Given SMS's ~160-character single-segment budget (and that multi-segment
SMS is more expensive and less reliable to concatenate correctly across
handsets), the response should be a fixed, terse template, not a reflow of
whatever fields the patient's `EMERGENCY_FIELD_ALLOWLIST` (from
`lib/emergency/capability.ts`) happens to include:

```
LAFIYA: BG O+ GT AA ALLERGY: Penicillin. Code exp in 6h. Not real-time.
```

- Always includes blood group and genotype if present ("BG UNK" if the
  patient hasn't recorded one — silence would be misread as "no allergy
  data" rather than "field not set").
- Allergies truncated to fit the segment budget; if allergies don't fit,
  respond with `ALLERGY: see printed card / call [clinic]` rather than
  silently dropping potentially critical info off the end of a truncated
  string.
- Deliberately **excludes** name, photo, medications, chronic conditions,
  and emergency contacts even if the patient's web capability allowlist
  includes them — this is a strictly smaller field set than what a
  `field_allowlist` on the web capability can carry, enforced by a fixed
  server-side template, not by patient-configurable choice, because SMS's
  exposure profile (§5) does not justify the same field breadth the web
  capability offers.
- Includes an explicit expiry/staleness disclaimer in every response
  ("Not real-time") since there is no equivalent of the web card's
  "Record updated" / "Verification last checked" timestamps in a
  160-character SMS.

### 4.2 Patient opt-in design

The existing capability system is opt-in by construction (a patient must
actively issue a capability). SMS/USSD needs an *additional*, separate
opt-in, not inherited from "the patient has an emergency card":

1. A distinct toggle in profile settings, off by default: "Allow SMS/USSD
   lookup for this card" — separate from, and not implied by, having any
   web `emergency` or `temporary` capability active.
2. Enabling it requires an explicit consent screen naming the specific
   trade-off in plain language: *"Text/USSD messages are not encrypted and
   may be visible to your phone carrier. Only blood group, genotype, and
   allergy information will be shared, never your name or contact
   details."* This mirrors ADR-003's existing pattern of surfacing
   trust/limitation text directly in the UI rather than only in policy
   docs.
3. Enabling it is the only action that causes a `sms_lookup_codes` row to
   be created; it never auto-derives from an existing `emergency_capabilities`
   row.
4. Revocation must be a single visible action (same affordance the web
   capability likely already exposes for revoke) and must immediately stop
   new resolutions — existing per-code `used_resolutions`/`max_resolutions`
   bookkeeping already caps blast radius even before an explicit revoke.
5. The short-code is only ever shown/printed alongside this opt-in — i.e.,
   a patient who never opts in never has a short-code to leak in the first
   place. This is a stronger default than "capability exists but nobody
   knows the code," because it means the code literally does not exist
   until the patient has seen and accepted the plaintext-transport
   disclosure.

## 5. Threat model

### 5.1 Carrier logging

**Threat:** MTN/Airtel/Glo/9mobile and the chosen aggregator (§2) can and
do log SMS content and USSD session content as a normal part of operating
their networks/platforms; this is not a hypothetical breach, it is business
as usual for GSM carriers and API aggregators.

**Mitigation:** Accept this as an inherent, undefeatable property of the
channel (Lafiya cannot make carrier SMSCs not log traffic) and design the
*payload* so that what's logged is minimally harmful: no patient name, no
persistent identifier, no contact info, no full medical history — just the
same bounded critical subset the issue names, and only for patients who
explicitly opted in with that disclosure in front of them (§4.2). This is
the same reasoning ADR-003 already applies to the public card page (fail
toward "reveal only the bounded critical subset," never toward "reveal
everything because the channel is already imperfect").

### 5.2 SIM swap

**Threat:** If any part of the design used the responder's or patient's
phone number as an *authorization* factor (e.g., "only allow lookups from a
pre-registered emergency-contact number"), a SIM swap against that number
would let an attacker either impersonate an authorized responder or, if the
patient's own number were used for opt-in confirmation, hijack the opt-in
flow itself.

**Mitigation:** The short-code is the sole authorization factor for a
lookup — deliberately **not** the responder's number. Any responder who has
the printed code can look it up; MSISDN is used only defensively, as a
rate-limiting *signal*, never as a grant of access. This also means a SIM
swap against the *patient's* number is a much narrower risk than it would
be if phone number doubled as an authentication factor: the worst case is
an attacker receiving the *opt-in confirmation SMS* (if one is sent) or
being able to change opt-in settings if opt-in changes ever get confirmed
purely via SMS reply — so opt-in/opt-out changes must require web
session auth (the existing Supabase auth session), never accept an SMS
reply alone as sufficient to toggle consent or reissue a code.

### 5.3 Enumeration

**Threat:** An attacker scripts USSD/SMS lookups against random 6-character
codes, hoping to harvest medical data at scale, or targets a specific known
patient by brute-forcing their (unknown) code.

**Mitigation:** This is the primary reason §3.4's layered rate limiting
exists rather than relying on keyspace alone (1.07B is large enough to deter
casual guessing but not an automated distributed attacker without rate
limits). Concretely: per-code max-resolutions cap, per-code TTL, per-MSISDN
and global throughput limits, indistinguishable failure responses for
unknown/expired/exhausted codes (never a distinguishing error that confirms
"this code exists but is expired" vs. "this code never existed" — that
distinction alone leaks 30 bits of information about the keyspace over
enough attempts), and abuse-pattern logging (§3.5) feeding a manual/ops
response path, mirroring how ADR-003 already treats "malformed, expired,
revoked, and unknown" web capabilities identically at the response layer.

### 5.4 Additional risk noted during this spike: aggregator webhook trust

Not named in the issue but surfaced by the design work above: the Lafiya
webhook that the aggregator calls for each USSD hop / inbound SMS must
authenticate that the request actually came from the contracted aggregator
(shared secret / signature header per the aggregator's documented scheme),
or an attacker who discovers the webhook URL could submit lookups directly,
bypassing the carrier/aggregator layer entirely (though not bypassing
Lafiya's own rate limits and short-code checks, which must never trust the
transport for authorization).

## 6. Go/no-go criteria

**Go** requires all of the following to hold before building past the
sandbox-validation stage:

1. A specific aggregator (Africa's Talking or Termii, or a third found
   during sandbox validation) confirms, in writing, current USSD session
   webhook latency/timeout behavior compatible with a single Postgres RPC
   round-trip from Lafiya's webhook handler (i.e., Lafiya's own p99 lookup
   latency, not just the aggregator's stated numbers, must fit inside the
   carrier's session timeout with margin).
2. Current, written pricing (not this spike's desk estimates) for USSD
   code/short-code leasing plus per-session/per-SMS cost is obtained and is
   judged acceptable relative to Lafiya's expected emergency-lookup volume.
3. Legal/compliance sign-off that SMS/USSD's plaintext-to-carrier exposure
   is compatible with Lafiya's data-protection obligations for the
   specific field subset in §4.1, given the explicit patient opt-in
   disclosure in §4.2 — this spike proposes the design but does not itself
   constitute that sign-off.
4. The rate-limiting and indistinguishable-failure-response design in §3.4
   and §5.3 is implemented and load-tested (comparable to how
   `docs/loadtest_get_emergency_card.md` already load-tests the web
   capability path) before any real short-codes are issued to patients.
5. A dedicated `sms_lookup_codes` opt-in exists and defaults to off, per
   §4.2 — the channel must never be enabled implicitly for existing
   emergency-capability holders.

**No-go / defer** if any of the following hold:

- Aggregator USSD session timeouts cannot reliably accommodate a live
  database round-trip from Lafiya's webhook (would force a pre-fetched,
  stale-payload design that undermines the "current data" value of the
  channel).
- Nigerian USSD short-code leasing lead time or cost is materially
  incompatible with the project's pilot timeline/budget (USSD code
  approval across Nigerian carriers commonly takes multiple weeks and is
  not something this spike can shortcut).
- Legal/compliance review concludes the carrier-visible plaintext exposure
  is not acceptable even with the minimal payload and explicit opt-in.

## 7. Sandbox prototype — why one isn't built in this PR

The issue allows "a working sandbox prototype, or a documented reason why
not." This PR is a documentation-only spike and does not build one, for
concrete reasons rather than as a shortcut:

- Both Africa's Talking and Termii sandbox environments require an account
  and API/sandbox credentials issued to a specific Lafiya-controlled
  account; this session has no such credentials, no ability to create them
  (they involve identity/business verification for Nigerian USSD/SMS
  products), and per this repo's own instruction not to send or persist
  real secrets, fabricating or hardcoding a prototype against a live
  aggregator without real credentials would not be a meaningful test — it
  would only prove that HTTP requests can be constructed, not that the
  session-timeout, latency, or cost assumptions in §2 hold.
- A real prototype also needs a leased Nigerian USSD short-code or SMS
  sender ID from the aggregator, which is itself a multi-week provisioning
  process with the telcos (§6's no-go condition), independent of any
  coding work — it cannot be stood up inside this spike's timeframe
  regardless of credentials.
- Building a prototype against mocked/local stand-ins for the aggregator
  webhook would validate Lafiya's own webhook handler logic (which is
  useful) but would not validate any of the actual open questions this
  spike exists to answer (session timeout headroom, real latency, real
  pricing) — so it would give false confidence rather than real signal
  without misrepresenting what was tested.

**Documented next step:** once an aggregator account and sandbox
credentials are available (tracked as the natural follow-up issue to this
spike), build a narrow prototype limited to: (a) one USSD session round-trip
returning a static test payload, to measure real session latency/timeout
headroom against §6 criterion 1, and (b) one inbound-SMS-triggered lookup,
before writing any production short-code issuance/rate-limit code. No PHI,
capability tokens, or real patient data should ever be used against a
third-party sandbox, consistent with this repo's contributor notes.

## 8. Summary recommendation

**Conditional go.** The design in §3–§5 is sound and reuses the existing
capability system's safety patterns (digest-only persistence, bounded
scope, indistinguishable failure responses, explicit opt-in) rather than
inventing a new trust model. The blocking unknowns are entirely external —
real aggregator session behavior, real current pricing, and Nigerian
USSD-code provisioning lead time — and are exactly what §6's go/no-go
criteria and §7's sandbox follow-up are scoped to resolve. No production
code should be written against a specific aggregator until an account with
real sandbox credentials exists and criteria 1–2 in §6 are confirmed.

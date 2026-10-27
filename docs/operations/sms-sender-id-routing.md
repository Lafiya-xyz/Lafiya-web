# SMS sender-ID registration and Nigerian routing (#803, #805)

## Routing classes

Every template in `lib/notifications/templates.ts` must map to a route in
`TEMPLATE_ROUTES` (`lib/notifications/routing.ts`). Security, emergency and
CHW notices use the **transactional** route (Termii `dnd` channel), which is
not filtered for numbers on the NCC Do-Not-Disturb registry. Promotional
(`generic`) traffic is filtered for DND numbers — never use it for anything a
patient must receive.

`instrumentation.ts` calls `validateSmsRouting()` at boot. Boot fails if a
template has no route, or (when `TERMII_API_KEY` is set) its sender ID env
var is unset or not in `TERMII_APPROVED_SENDER_IDS` (comma-separated).

## Sender-ID register

| Sender ID | Route          | Provider | Registration status | Renewal date | Owner          |
| --------- | -------------- | -------- | ------------------- | ------------ | -------------- |
| `Lafiya`  | transactional  | Termii   | _fill in_           | _fill in_    | _ops on-call_  |

Update this table whenever a sender ID is registered, renewed or rejected.
Set a calendar reminder 30 days before each renewal date.

## Delivery receipts

- Termii: `POST /api/notifications/receipts/termii`, signed `X-Termii-Signature`
  (HMAC-SHA512 of raw body, `TERMII_WEBHOOK_SECRET`).
- Twilio: `POST /api/notifications/receipts/twilio`, signed `X-Twilio-Signature`
  (`TWILIO_AUTH_TOKEN`, URL from `TWILIO_STATUS_CALLBACK_URL`).

Receipts move `notification_deliveries.delivery_state` forward only
(`pending → accepted → sent → delivered|undelivered|failed`); replays and
out-of-order receipts are no-ops. Messages still unconfirmed 10 minutes after
sending are picked up by `escalateOverdueDeliveries()` for alternate-channel
escalation.

## Monitoring

`GET /api/internal/readiness` → `components.smsDelivery` reports 24 h success
rates `byProviderCountry` (e.g. `termii:+234`) and `byNetwork` (MTN, Airtel,
Glo, 9mobile). Only aggregates are exposed — no numbers or message IDs.
Alert if any network drops below 90 % over a meaningful sample.

## Runbook: sender-ID rejection

Symptoms: Termii returns an error mentioning the sender ID, or a network's
success rate collapses to ~0 while others are healthy.

1. Check the network breakdown in readiness to confirm scope (one network vs. all).
2. In the Termii dashboard, check the sender ID's status for that network.
3. **Fallback**: Twilio is the automatic secondary provider when Termii fails;
   if Termii accepts but the network drops messages, temporarily open the
   Termii circuit (or unset `TERMII_API_KEY` in the affected deployment) so
   traffic fails over to Twilio's international route.
4. Re-submit the sender-ID registration with Termii/NCC; record the ticket and
   new expected date in the register above.
5. Once restored, revert the fallback and watch the network rate recover.

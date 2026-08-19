# ADR 0010: No mandatory central user control plane

## Status

Accepted as an architectural guardrail. This ADR records a product-direction decision; it does not
implement client identity, dedicated-server separation, or server-local permissions — those are
future tasks (see "Consequences" below).

## Context

Disco Voador's product goal (`docs/PRODUCT.md`) is a self-hosted, Discord-like communication core
without becoming a centralized social platform. T0–T6 delivered the desktop shell, realtime
signaling, and the full P2P media stack (voice, camera, screen-video, screen-audio) against exactly
one self-hosted realtime service per deployment, with no account system, no central user database,
and no vendor SaaS dependency for core communication (see ADR 0004).

As the product matures toward a genuine TeamSpeak-style model — local client identity, dedicated
self-hosted server instances an operator runs independently, server-local permissions/groups/bans —
it becomes important to record explicitly, before those tasks begin, that this direction is the
accepted target and not merely an implementation detail that could quietly drift toward a
centralized-accounts model under future feature pressure (e.g., "just add login so we can sync
settings across devices"). Recording the guardrail now lets later tasks be reviewed against it
rather than each one re-litigating the same question.

## Decision

**Accepted:** Disco Voador's product architecture does not require, and must not come to require,
any of the following for core communication to function:

- central user accounts, email addresses, phone numbers, or real-name identity;
- password or credential storage in a central database;
- social login or third-party identity federation;
- a global user profile or directory;
- a mandatory central server directory/discovery service;
- centralized message or media storage across independent deployments;
- a centralized media relay (media stays P2P-first, SFU-ready per ADR 0006, but never
  vendor-hosted);
- any mandatory Disco Voador–operated cloud service (no `api.discovoador.com`,
  `auth.discovoador.com`, `analytics.discovoador.com`, `license.discovoador.com`, or equivalent).

The target shape (to be implemented by later tasks, not this ADR):

```text
Disco Voador Client
        |
        v
user-selected self-hosted
Disco Voador Dedicated Server
```

A client connects to whichever self-hosted server its user chooses to point it at. Identity is
client-local (cryptographic, not account-based). Permissions, groups, invites, and bans are
server-local state an operator controls, not centrally issued or centrally revocable. No component
of the product may assume there is exactly one global namespace of users or servers.

## Consequences

- Every future task that touches identity, authentication, or cross-server behavior must be
  evaluated against this ADR before design, not after implementation.
- Planned follow-on tasks this ADR anticipates but does not implement:
  - **T7 — local cryptographic client identity**: TeamSpeak-style client-side identity: no central
    account, no email, no username/password database.
  - **T8 — dedicated server product boundary**: a client connects to an independently-hosted
    server; no mandatory Disco Voador cloud/control plane.
  - **T9 — server-local groups, permissions, invite/privilege tokens, and bans.**
  - Later: minimal/ephemeral text chat, devices/bookmarks/reconnect UX, per-process/game audio,
    a self-hosting production package (TURN/TLS/Docker/configuration), a Windows client installer
    and dedicated-server release process, UX polish, and an SFU only if measured scale justifies
    one — see `docs/tasks/STATUS.md` for current sequencing.
- This ADR does not by itself prohibit a _future_, explicitly-opted-in, genuinely optional hosted
  offering (e.g., a convenience relay or update service) — it prohibits that offering from ever
  being _required_ for core communication between a self-hosting operator and their own users.
- Monetization, ads, subscriptions, and licensing infrastructure remain explicitly out of scope for
  every task this ADR anticipates; introducing them would itself require a new ADR superseding or
  amending this one, not a routine feature task.

## Alternatives

- **Add accounts now, defer the self-hosted-identity model:** rejected — building even a minimal
  central account system first would create migration pressure away from client-local identity
  later, and contradicts the self-hosted-first product principle (`docs/PRODUCT.md`) from the
  start.
- **Leave this undocumented and decide case-by-case per task:** rejected — the whole point of
  recording it now is to give later tasks (and reviewers) a stable reference instead of an implicit,
  easily-eroded assumption.
- **Fully design T7–T9 in this ADR:** rejected — this ADR is a guardrail, not an implementation plan;
  each of those tasks needs its own investigation, interface design, and acceptance criteria when it
  actually starts.

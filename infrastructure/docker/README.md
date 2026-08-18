# Docker Compose templates

These files are deployment templates, not a working T0 stack. The production-oriented TURN
template uses Linux host networking because relaying a large UDP range through Docker NAT has an
operational cost. The bridge template is only for constrained local validation.

Before use, create the ignored Coturn configuration from the corresponding example, append a
strong runtime-only secret, set a public/private `external-ip` mapping when behind NAT, and review
the firewall and denied/allowed peer ranges. The examples intentionally contain no usable secret.
See [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) and the self-hosting skill.

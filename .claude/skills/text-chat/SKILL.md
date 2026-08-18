---
name: text-chat
description: Implement or modify Disco Voador text channels, message delivery, history, editing, deletion, authorization, or SQLite-backed chat persistence. Use for text-chat domain work and keep it separate from WebRTC media transport.
---

# Develop text chat

Read the active task, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, ADR 0005, and ADR 0009. Use `realtime-protocol`; consult `realtime-backend-engineer`.

1. Define channel/message rules, identity, timestamps, edit/delete semantics, and authorization before
   storage details.
2. Carry live events through the realtime service and canonical runtime-validated protocol—never
   WebRTC media/data transport.
3. Put persistence behind operations required by the domain. Keep SQLite SQL/migrations in an
   adapter and preserve a credible PostgreSQL replacement seam without emulating it prematurely.
4. Specify pagination/order, reconnect catch-up, optimistic updates, duplicate delivery, conflict,
   and deletion visibility.
5. Bound and safely render user content; do not treat Markdown/links/attachments as trusted HTML.
6. Test authorization, ordering, pagination, edit/delete, restart persistence, migrations,
   concurrency/transactions, duplicates, and two-client delivery as applicable.
7. Document backup/restore and data-retention implications when persistence becomes operational.

Report domain rules, schema/protocol/storage changes, compatibility/migration plan, abuse controls,
two-client and restart evidence, and deferred features.

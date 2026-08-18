# Realtime service boundary

This workspace will host the self-hosted WebSocket service. Its internal modules will separate
connection handling, presence, voice signaling, text chat, and protocol dispatch. It must never
relay media payloads. T0 contains no listening server or product behavior.

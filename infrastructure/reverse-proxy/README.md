# Reverse proxy boundary

A future reverse proxy may terminate TLS and forward HTTP/WebSocket traffic to the realtime
service. TURN is not ordinary HTTP traffic: expose it directly or use an explicitly configured L4
proxy. No reverse-proxy product configuration exists in T0.

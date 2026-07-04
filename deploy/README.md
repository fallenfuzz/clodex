# Phone access deployment

Reaches the Clodex phone view (remote.js, 127.0.0.1:7900) from off-machine.

## clodex-mobile.yaml

- **Service** `clodex-mobile` (ns `workbench`) — ExternalName → `host.docker.internal:7900`,
  the docker-desktop trick that lets the in-cluster nginx reach the Mac-local server.
  Same pattern as the existing `wb-mobile` / `wb-main` services.
- **Ingress** `clodex-mobile` — host `clodex.dinzona.ro`, path `/`, TLS via the
  `dinzona-wildcard-tls` wildcard cert, plus **nginx basic auth** (secret
  `clodex-mobile-auth`). SSE-friendly annotations (proxy-buffering off, long
  read timeout) copied from wb-mobile.

## Auth

Basic auth is nginx-layer (annotations), scoped to this ingress only —
wb-mobile/workbench are untouched. Secret is NOT in the manifest.

Rotate / (re)create:

```
NEWPASS='...'
htpasswd -nbB bogdan "$NEWPASS" > /tmp/htpasswd   # or: openssl passwd -apr1
kubectl create secret generic clodex-mobile-auth -n workbench \
  --from-file=auth=/tmp/htpasswd --dry-run=client -o yaml | kubectl apply -f -
```

User `bogdan`; password lives in bogdan's password manager, not here.

## DNS

Cloudflare CNAME `clodex` → `servicii.home.ro`, proxied (orange cloud) —
same as every other dinzona.ro subdomain; the ISP hostname is the router in,
nginx selects by Host header.

## Caveat

Cloudflare's proxy caps a single response at ~100s, so the SSE stream
(`/api/events`) drops roughly every 100s. The page auto-reconnects with
backoff (brief connection-dot blink), so it self-heals. Only a cosmetic
concern; a proactive client heartbeat would remove the blink if it matters.

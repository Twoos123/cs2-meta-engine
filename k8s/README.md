# Kubernetes (k3s) deployment

Single-node [k3s](https://k3s.io) on the `cs2-docker` VM. Bundled Traefik
terminates `:80` and routes `/api` directly to the FastAPI Service and
everything else to the nginx static Service (nginx's internal `/api` proxy
is dormant here). Storage is the bundled local-path provisioner; the backend
runs `replicas: 1` by design (in-process ingest state + single-writer SQLite)
with `strategy: Recreate`.

## Install

```bash
curl -sfL https://get.k3s.io | sh -
```

## Load images (no registry until Phase 3 CI/CD)

```bash
docker save cs2-meta-engine/backend:latest cs2-meta-engine/web:latest \
  | sudo k3s ctr images import -
```

## Secrets (never committed)

```bash
kubectl create namespace cs2
kubectl -n cs2 create secret generic cs2-secrets \
  --from-literal=ANTHROPIC_API_KEY=... \
  --from-literal=OPENROUTER_API_KEY= \
  --from-literal=FACEIT_API_KEY= \
  --from-literal=RCON_PASSWORD=changeme
```

## Deploy

```bash
kubectl apply -f k8s/
kubectl -n cs2 rollout status deploy/backend deploy/web
```

App is served on port 80 of the node (Traefik via klipper-lb).

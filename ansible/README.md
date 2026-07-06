# Ansible — VM configuration

Converges the `cs2-docker` VM from a fresh Debian 13 cloud image (provisioned
by `../terraform`) to the full stack: base packages, Docker CE, the loopback
image registry, k3s, the GitHub Actions runner, and the app's Kubernetes
resources. Secrets are created only-if-missing with placeholder/generated
values — real values are never stored here.

## Control node (containerized — Ansible doesn't run on native Windows)

```bash
docker build -t cs2-ansible -f control-node.Dockerfile .
docker run --rm -v "$PWD:/work" -v "$HOME/.ssh/id_ed25519:/key:ro" -w /work \
  cs2-ansible bash -c 'mkdir -p ~/.ssh && cp /key ~/.ssh/id_ed25519 && \
  chmod 600 ~/.ssh/id_ed25519 && ansible-playbook site.yml'
```

## Fresh VM notes

- First full converge takes several minutes (k3s install, image pulls).
- Runner registration needs a short-lived token:
  `-e runner_token=$(gh api -X POST repos/Twoos123/cs2-meta-engine/actions/runners/registration-token --jq .token)`
- After converge, populate the registry by re-running the deploy workflow
  (`gh workflow run deploy` or any push) — the cluster pulls images from
  `localhost:5000`, which starts empty on a fresh box.
- Add real API keys later:
  `kubectl -n cs2 delete secret cs2-secrets && kubectl -n cs2 create secret generic cs2-secrets --from-literal=ANTHROPIC_API_KEY=... ; kubectl -n cs2 rollout restart deploy/backend`

## Idempotency

The playbook is convergence-tested against the live VM: a second run reports
`changed=0`.

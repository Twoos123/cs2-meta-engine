# Terraform — public HTTPS via Cloudflare Tunnel + Access login

Publishes the k3s app at `https://<hostname>` without opening any port on
the homelab. `cloudflared` runs inside the cluster and dials out to
Cloudflare; Cloudflare Access puts a login (email one-time PIN) in front.

```
browser ─HTTPS─▶ Cloudflare edge ─Access login─▶ tunnel ─▶ cloudflared (k3s) ─▶ Traefik ─▶ web / api
```

Separate root from `../` (Proxmox): different provider and credentials,
its own local state (gitignored — it contains the tunnel secret).

## What it creates
| Resource | Purpose |
|---|---|
| `cloudflare_zero_trust_tunnel_cloudflared` | Remotely managed tunnel (`config_src = "cloudflare"`) |
| `cloudflare_zero_trust_tunnel_cloudflared_config` | Ingress: `<hostname>` → `http://traefik.kube-system.svc.cluster.local:80`, everything else 404 |
| `cloudflare_dns_record` | Proxied CNAME `<hostname>` → `<tunnel-id>.cfargotunnel.com` |
| `cloudflare_zero_trust_access_identity_provider` | One-time PIN login (skip with `create_otp_idp = false` if the account has one) |
| `cloudflare_zero_trust_access_application` | Self-hosted app with an inline allow policy for `allowed_emails` / `allowed_email_domains` |

## Prerequisites
- A domain on Cloudflare (its zone ID) and a Zero Trust account (free plan works).
- An API token with: Account › Cloudflare Tunnel: Edit, Account › Access: Apps and
  Policies: Edit, Account › Access: Organizations, Identity Providers, and Groups: Edit,
  Zone › DNS: Edit.

## Usage
```bash
cd terraform/cloudflare
cp terraform.tfvars.example terraform.tfvars      # token, account/zone ids, hostname, emails
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest init
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest apply

# hand the connector token to Ansible (deploys cloudflared into the cs2 namespace)
TOKEN=$(docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest output -raw tunnel_token)
cd ../../ansible && ansible-playbook site.yml -e cloudflared_tunnel_token="$TOKEN"
```

Commit the generated `.terraform.lock.hcl` after the first `init`.

## Notes
- The app's own `ADMIN_TOKEN` still guards destructive actions behind the login.
- CS2 Game State Integration and the browser extension talk to the backend
  directly on the LAN (`http://192.168.6.50`), not through the tunnel —
  Access would require a service token for non-browser clients.
- CI runs `terraform validate` on this root (no credentials needed).

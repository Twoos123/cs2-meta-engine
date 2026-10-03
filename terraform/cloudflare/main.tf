# Public HTTPS entry for the k3s app via a Cloudflare Tunnel, gated by
# Cloudflare Access (login). Nothing on the homelab is port-forwarded:
# cloudflared inside the cluster dials out to Cloudflare's edge.
#
#   browser ──HTTPS──▶ Cloudflare edge ──Access login──▶ tunnel ──▶ cloudflared pod
#                                                              ──▶ Traefik ──▶ web / api
#
# The tunnel is remotely managed (config_src = "cloudflare"): ingress rules
# live here, and the in-cluster cloudflared only needs the token output below.

resource "random_bytes" "tunnel_secret" {
  length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "app" {
  account_id    = var.account_id
  name          = var.tunnel_name
  config_src    = "cloudflare"
  tunnel_secret = random_bytes.tunnel_secret.base64
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "app" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id

  config = {
    ingress = [
      {
        hostname = var.hostname
        # k3s' bundled Traefik already routes /api → backend, / → web
        service = var.origin_service
      },
      # Catch-all: anything else that reaches the tunnel gets a 404
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.app.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # automatic (required for proxied records)
}

# One-time PIN login (email code). Cloudflare allows a single OTP provider
# per account — set create_otp_idp = false if the account already has one.
resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  count      = var.create_otp_idp ? 1 : 0
  account_id = var.account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}

resource "cloudflare_zero_trust_access_application" "app" {
  account_id       = var.account_id
  name             = "CS2 Meta Engine"
  type             = "self_hosted"
  domain           = var.hostname
  session_duration = var.session_duration

  policies = [
    {
      name       = "Allowed viewers"
      decision   = "allow"
      precedence = 1
      include = concat(
        [for e in var.allowed_emails : { email = { email = e } }],
        [for d in var.allowed_email_domains : { email_domain = { domain = d } }],
      )
    },
  ]
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "app" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id
}

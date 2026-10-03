output "url" {
  value = "https://${var.hostname}"
}

output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.app.id
}

# Feed to Ansible: -e cloudflared_tunnel_token=$(terraform output -raw tunnel_token)
output "tunnel_token" {
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.app.token
  sensitive = true
}

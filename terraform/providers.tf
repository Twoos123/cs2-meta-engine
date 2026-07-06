provider "proxmox" {
  endpoint  = var.proxmox_endpoint
  api_token = var.proxmox_api_token
  # homelab PVE serves a self-signed certificate
  insecure = true
}

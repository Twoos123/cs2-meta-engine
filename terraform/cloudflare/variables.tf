variable "api_token" {
  description = "Cloudflare API token: Account › Cloudflare Tunnel:Edit, Account › Access: Apps and Policies:Edit, Account › Access: Organizations, Identity Providers, and Groups:Edit, Zone › DNS:Edit"
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "zone_id" {
  description = "Zone ID of the domain the app is published under"
  type        = string
}

variable "hostname" {
  description = "Public hostname, e.g. cs2.example.com"
  type        = string
}

variable "tunnel_name" {
  description = "Tunnel name shown in the Zero Trust dashboard"
  type        = string
  default     = "cs2-meta-engine"
}

variable "origin_service" {
  description = "Where cloudflared forwards traffic inside the cluster (k3s Traefik)"
  type        = string
  default     = "http://traefik.kube-system.svc.cluster.local:80"
}

variable "allowed_emails" {
  description = "Emails allowed through Cloudflare Access (one-time PIN login)"
  type        = list(string)
  default     = []
}

variable "allowed_email_domains" {
  description = "Whole email domains allowed through Access"
  type        = list(string)
  default     = []
}

variable "session_duration" {
  description = "How long an Access login lasts"
  type        = string
  default     = "24h"
}

variable "create_otp_idp" {
  description = "Create the one-time PIN identity provider (only one may exist per account)"
  type        = bool
  default     = true
}

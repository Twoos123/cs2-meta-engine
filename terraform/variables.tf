variable "proxmox_endpoint" {
  type    = string
  default = "https://192.168.4.21:8006"
}

variable "proxmox_api_token" {
  description = "user@realm!tokenid=uuid — see terraform/README.md for creation"
  type        = string
  sensitive   = true
}

variable "node_name" {
  type    = string
  default = "pve"
}

variable "vm_id" {
  type    = number
  default = 101
}

variable "vm_name" {
  type    = string
  default = "cs2-docker"
}

variable "vm_cores" {
  type    = number
  default = 4
}

# Fixed allocation, no balloon floor: kubelet reads MemTotal once at boot,
# so dynamic ballooning under Kubernetes is an anti-pattern.
variable "vm_memory_mib" {
  type    = number
  default = 12288
}

variable "vm_disk_gb" {
  type    = number
  default = 150
}

variable "vm_ip_cidr" {
  type    = string
  default = "192.168.6.50/22"
}

variable "vm_gateway" {
  type    = string
  default = "192.168.4.1"
}

variable "vm_dns_servers" {
  type    = list(string)
  default = ["192.168.2.1"]
}

variable "ssh_public_key" {
  description = "OpenSSH public key granted to the debian cloud-init user"
  type        = string
}

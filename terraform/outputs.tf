output "vm_id" {
  value = proxmox_virtual_environment_vm.cs2_docker.vm_id
}

output "vm_ip" {
  value = var.vm_ip_cidr
}

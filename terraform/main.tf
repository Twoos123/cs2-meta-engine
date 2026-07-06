# Debian 13 genericcloud image, downloaded by the PVE node itself into the
# 'local' datastore (requires the 'import' content type — see README).
resource "proxmox_download_file" "debian13_cloud" {
  content_type = "import"
  datastore_id = "local"
  node_name    = var.node_name
  url          = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
  file_name    = "debian-13-genericcloud-amd64.qcow2"
}

resource "proxmox_virtual_environment_vm" "cs2_docker" {
  name      = var.vm_name
  node_name = var.node_name
  vm_id     = var.vm_id
  on_boot   = true

  agent {
    enabled = true
  }

  cpu {
    cores = var.vm_cores
    type  = "host"
  }

  # dedicated only — no `floating` means the balloon device stays disabled
  memory {
    dedicated = var.vm_memory_mib
  }

  scsi_hardware = "virtio-scsi-single"

  disk {
    datastore_id = "local-lvm"
    interface    = "scsi0"
    size         = var.vm_disk_gb
    discard      = "on"
    import_from  = proxmox_download_file.debian13_cloud.id
  }

  network_device {
    bridge = "vmbr0"
    model  = "virtio"
  }

  # genericcloud images have no GPU console — serial only
  serial_device {}
  vga {
    type = "serial0"
  }

  operating_system {
    type = "l26"
  }

  initialization {
    datastore_id = "local-lvm"

    ip_config {
      ipv4 {
        address = var.vm_ip_cidr
        gateway = var.vm_gateway
      }
    }

    dns {
      servers = var.vm_dns_servers
    }

    user_account {
      username = "debian"
      keys     = [var.ssh_public_key]
    }
  }

  lifecycle {
    # this VM is production — a plan that wants to replace it must never apply
    prevent_destroy = true
    # brownfield import: the live disk was created with `qm import`, so the
    # create-only import_from lineage can't match
    ignore_changes = [disk[0].import_from]
  }
}

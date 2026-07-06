# Terraform — VM provisioning on Proxmox

Manages the `cs2-docker` VM (id 101) on the PVE host via the
[bpg/proxmox](https://registry.terraform.io/providers/bpg/proxmox) provider
(version pinned by `.terraform.lock.hcl`). State is local and gitignored.

Verified brownfield parity: after `terraform import`, `terraform plan`
reports **"No changes. Your infrastructure matches the configuration."**

## One-time PVE prerequisites (as root on pve)

```bash
# scoped API role — note the PVE 9 privilege names (VM.GuestAgent.Audit;
# VM.Monitor no longer exists)
pveum role add TerraformProv -privs "Datastore.Allocate Datastore.AllocateSpace \
  Datastore.AllocateTemplate Datastore.Audit SDN.Use Sys.Audit Sys.Modify \
  VM.Allocate VM.Audit VM.Clone VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit \
  VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network \
  VM.Config.Options VM.Migrate VM.PowerMgmt VM.GuestAgent.Audit"
pveum user add terraform@pve
pveum aclmod / -user terraform@pve -role TerraformProv
pveum user token add terraform@pve provisioner -privsep 0   # → terraform.tfvars

# allow qcow2 imports on the local datastore
pvesm set local --content iso,vztmpl,backup,snippets,import
```

## Usage (containerized CLI — no local install needed)

```bash
cp terraform.tfvars.example terraform.tfvars   # fill in token + ssh key
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest init
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest plan
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest apply
```

## Adopting an existing VM (brownfield)

```bash
docker run --rm -v "$PWD:/tf" -w /tf hashicorp/terraform:latest \
  import proxmox_virtual_environment_vm.cs2_docker pve/101
```

The live disk was originally created with `qm import`, so `disk.import_from`
lineage can't match — it's in `ignore_changes`. `prevent_destroy` guards the
VM: a plan that wants to replace it will refuse to apply.

## Greenfield rebuild

`terraform apply` on empty state downloads the Debian 13 genericcloud image
onto the node and builds the VM from it (cloud-init: static IP, debian user,
SSH key). Then run the Ansible playbook (`../ansible`) to configure the OS,
Docker, registry, k3s, runner, and app — see `ansible/README.md`.

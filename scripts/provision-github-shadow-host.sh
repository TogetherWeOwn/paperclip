#!/usr/bin/env bash
# OPERATOR-REVIEWED TEMPLATE ONLY. This file is never run by the server.
# Usage: bash provision-github-shadow-host.sh --apply AUTHORIZED_PUBLIC_KEY PRIMARY_ROOT...
# This prepares a NEW principal; it does NOT certify or enable any environment.
# Review the companion .txt before applying on a staging host.
set -euo pipefail
if [[ ${1:-} != --apply || $# -lt 3 ]]; then
  printf '%s\n' 'No changes made. Review github-shadow-certified-environment.txt first.' \
    'Explicit invocation: bash provision-github-shadow-host.sh --apply PUBLIC_KEY_FILE PRIMARY_ROOT...'
  exit 0
fi
shift
[[ $(id -u) = 0 ]] || { printf '%s\n' 'Run only as the host operator with root authority.' >&2; exit 1; }
key_file=$1; shift
[[ -f $key_file ]] || exit 1
for command in useradd getent install iptables ip6tables setfacl getfacl sshd python3 findmnt; do command -v "$command" >/dev/null; done
if getent passwd paperclip-shadow >/dev/null; then
  printf '%s\n' 'Refusing to repurpose an existing account. Audit it manually; no changes made.' >&2
  exit 1
fi
# Do not silently change global /proc policy: that affects the primary too.
# Without process isolation, /proc can expose another user's launch environment.
findmnt -n -o OPTIONS /proc | grep -Eq '(^|,)hidepid=(2|invisible)(,|$)' || {
  printf '%s\n' 'Use a dedicated staging host with hidepid=2 already enabled; no changes made.' >&2; exit 1;
}
for root in "$@"; do
  [[ $root = /* && $root != / && $root != /home && $root != /etc && -d $root ]] || {
    printf '%s\n' 'Primary roots must be existing specific absolute directories, not shared system roots.' >&2; exit 1;
  }
done
# A public key is the only input credential. Never copy private keys to this user.
python3 - "$key_file" <<'PY'
import pathlib, sys
lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
assert len(lines) == 1 and lines[0].startswith(('ssh-ed25519 ', 'ssh-rsa ', 'ecdsa-sha2-')), 'Expected one unoptioned SSH public key'
PY
receipt_dir=$(mktemp -d /root/paperclip-shadow-provision.XXXXXXXX)
chmod 700 "$receipt_dir"
getfacl -p -- "$@" > "$receipt_dir/primary-roots.acl"
useradd --home-dir /home/paperclip-shadow --no-create-home --shell /bin/sh --user-group paperclip-shadow
uid=$(id -u paperclip-shadow)
# Root owns the login HOME and every profile search path. The principal cannot
# replace .profile/.bashrc or insert a fake python/claude into the launch PATH.
install -d -o root -g root -m 0755 /home/paperclip-shadow /home/paperclip-shadow/.paperclip-runtime
install -d -o root -g root -m 0755 /home/paperclip-shadow/.ssh
printf 'restrict %s\n' "$(<"$key_file")" > /home/paperclip-shadow/.ssh/authorized_keys
chmod 0644 /home/paperclip-shadow/.ssh/authorized_keys
install -d -o paperclip-shadow -g paperclip-shadow -m 0700 \
  /home/paperclip-shadow/.paperclip-runtime/isolated /home/paperclip-shadow/work
for root in "$@"; do setfacl -m u:paperclip-shadow:--- -- "$root"; done
# Install BOTH families before the account is used. Reject DNS, all Internet,
# other loopback ports and all UDP. Do not add a broad ESTABLISHED exception.
for firewall in iptables ip6tables; do
  "$firewall" -w -N PC_SHADOW_EGRESS
  if [[ $firewall = iptables ]]; then
    "$firewall" -w -A PC_SHADOW_EGRESS -o lo -d 127.0.0.1/32 -p tcp -m multiport --dports 3100,8317 -j ACCEPT
  fi
  "$firewall" -w -A PC_SHADOW_EGRESS -j REJECT
  "$firewall" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -j PC_SHADOW_EGRESS
done
# 'restrict' on the key denies forwarding, PTY and user rc. Audit all sshd Match
# rules too: PermitUserEnvironment=no, PasswordAuthentication=no, no other keys.
sshd -T -C user=paperclip-shadow,host=localhost,addr=127.0.0.1 > "$receipt_dir/sshd-effective.txt"
printf '%s\n' "$uid" > "$receipt_dir/uid.txt"
printf '%s\n' 'Prepared only; NOT CERTIFIED. No server config was changed.' \
  "Operator receipt directory: $receipt_dir" \
  'Persist the firewall policy using the host-managed mechanism before certification.' \
  'Audit the API/proxy, filesystem mounts, groups, sockets and root-owned binaries.' \
  'If any step failed, keep certification EMPTY; inspect partial installation and use the documented rollback.'

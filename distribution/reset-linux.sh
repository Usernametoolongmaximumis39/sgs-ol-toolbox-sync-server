#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'Run this password reset with sudo.' >&2; exit 1; }
root=$(dirname "$(readlink -f "$0")")
service=${root##*/}
exec 9>"/run/lock/$service-install.lock"
flock -n 9 || { echo 'An install or password reset is already running.' >&2; exit 1; }
systemctl stop "$service"
trap 'systemctl start "$service"' EXIT
password=$(runuser -u "$service" -- "$root/runtime/node" "$root/current/tools/appearance-sync.mjs" \
    --data-dir "/var/lib/$service" --reset-admin-password)
printf '%s\n' "$password" | grep -Eq '^A1[A-Za-z0-9_-]{43}$'
printf 'New admin password: %s\n' "$password"
systemctl start "$service"
trap - EXIT
read -r sync_port admin_port < "$root/installed"
for attempt in $(seq 1 30); do
    if systemctl is-active --quiet "$service" &&
        curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$admin_port/admin/" >/dev/null 2>&1; then exit; fi
    sleep 1
done
echo "Admin panel failed its startup check. Inspect: journalctl -u $service -n 50" >&2
exit 1

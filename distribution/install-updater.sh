#!/bin/sh
set -eu

if [ "$#" -ne 4 ] || [ "$(id -u)" -ne 0 ]; then
    echo 'Usage (root): sh install-updater.sh INSTALL_ROOT DATA_DIR SERVICE_NAME ADMIN_PORT' >&2
    exit 2
fi
root=$(realpath -- "$1")
data=$(realpath -- "$2")
service=${3%.service}
port=$4
printf '%s\n' "$root" "$data" | awk '!/^\/[A-Za-z0-9./_-]+$/ { exit 1 }'
printf '%s\n' "$service" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*$'
printf '%s\n' "$port" | grep -Eq '^[1-9][0-9]{0,4}$'
test "$port" -le 65535
test "$(stat -c %u "$root")" = 0
test -f "$root/current/server-version.json"
test "$(systemctl show -p LoadState --value "$service.service")" = loaded

control="/var/lib/$service-update"
unit="/etc/systemd/system/$service-update"
uid=$(stat -c %u "$data")
gid=$(stat -c %g "$data")
test "$uid" -ne 0
install -d -m 755 -o root -g root "$control"
install -d -m 700 -o "$uid" -g "$gid" "$control/requests"
install -m 644 "$(dirname "$0")/update-server.py" "$root/update-server.py"

cat > "$unit.service" <<EOF
[Unit]
Description=Check or install $service server updates
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $root/update-server.py $root $control $service.service $port
TimeoutStartSec=8min
UMask=0022
EOF
cat > "$unit.path" <<EOF
[Unit]
Description=Wait for $service administration update requests

[Path]
PathExists=$control/requests/update.json

[Install]
WantedBy=multi-user.target
EOF
cat > "$unit.timer" <<'EOF'
[Unit]
Description=Periodically check for sync server releases

[Timer]
OnActiveSec=10s
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now "$service-update.path" "$service-update.timer"
printf 'Update directory: %s\n' "$control"

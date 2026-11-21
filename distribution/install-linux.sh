#!/bin/sh
set -eu
umask 077

service=sgs-toolbox-sync
sync_port=17429
admin_port=17430
setup_port=17431
setup_host=
repo=https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server
bundle=sgs-ol-toolbox-sync-server.tar.gz
node_version=v24.20.0

fail() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help) echo 'sudo sh install-linux.sh [--host PUBLIC_IP_OR_DNS] [--service-name NAME] [--sync-port PORT] [--admin-port PORT] [--setup-port PORT]'; exit ;;
        --host|--service-name|--sync-port|--admin-port|--setup-port)
            [ "$#" -ge 2 ] || fail "Missing argument for $1"
            case "$1" in
                --service-name) service=$2 ;;
                --sync-port) sync_port=$2 ;;
                --admin-port) admin_port=$2 ;;
                --setup-port) setup_port=$2 ;;
                --host) setup_host=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]') ;;
            esac
            shift 2 ;;
        *) fail "Unknown option: $1" ;;
    esac
done
[ "$(id -u)" = 0 ] || fail 'Run this installer as root (sudo).'
printf '%s\n' "$service" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' || fail 'Invalid service name.'
for port in "$sync_port" "$admin_port" "$setup_port"; do
    printf '%s\n' "$port" | grep -Eq '^[1-9][0-9]{0,4}$' && [ "$port" -le 65535 ] || fail 'Invalid TCP port.'
done
[ "$sync_port" != "$admin_port" ] || fail 'Sync and admin ports must differ.'
if [ -n "$setup_host" ]; then
    [ "$sync_port" != "$setup_port" ] && [ "$admin_port" != "$setup_port" ] || fail 'The setup port must use a separate port.'
fi
[ -d /run/systemd/system ] || fail 'This installer requires systemd as the host service manager.'
case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) fail 'Supported Linux architectures: x64 and arm64.' ;;
esac

root=/opt/$service
data=/var/lib/$service
control=/var/lib/$service-update
unit=/etc/systemd/system/$service.service
exec 9>"/run/lock/$service-install.lock"
flock -n 9 || fail 'An install or password reset is already running.'

download() {
    curl --fail --silent --show-error --location --retry 3 --retry-connrefused \
        --connect-timeout 15 --max-time 180 --proto '=https' --proto-redir '=https' --output "$2" "$1"
}
await_admin() {
    for attempt in $(seq 1 30); do
        if systemctl is-active --quiet "$service" &&
            curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$admin_port/admin/" | grep -q 'id="login"'; then return; fi
        sleep 1
    done
    fail "Admin panel failed its startup check. Inspect: journalctl -u $service -n 50"
}
show_access() {
    printf '\nLocal admin login: http://127.0.0.1:%s/admin/\n' "$admin_port"
    printf 'Admin TCP port: %s (loopback only)\n' "$admin_port"
    printf 'Initial sync TCP port: %s (loopback only)\n' "$sync_port"
    printf 'Public sync and HTTPS admin: configure a domain, certificate and separate TCP port in the panel (e.g. 8888).\n'
    printf 'From your own computer: ssh -N -L %s:127.0.0.1:%s USER@SERVER\n' "$admin_port" "$admin_port"
    printf 'Password reset: sudo %s/reset-admin-password\n' "$root"
}

if [ -f "$root/installed" ]; then
    [ "$(cat "$root/installed")" = "$sync_port $admin_port" ] || fail 'This instance uses different port arguments.'
    systemctl start "$service"
    await_admin
    show_access
    echo 'Existing installation kept. Use the admin panel to update the server or the reset command if you lost the password.'
    exit
fi
if [ -e "$root" ] || [ -e "$data" ] || [ -e "$control" ] || [ -e "$unit" ] || getent passwd "$service" >/dev/null; then
    fail 'Installation paths or user already exist. Choose another --service-name for a separate instance.'
fi

missing=
for cmd in curl python3 xz; do command -v "$cmd" >/dev/null || missing=yes; done
if [ -n "$missing" ] || [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
    command -v apt-get >/dev/null || fail 'Install curl, ca-certificates, python3 and xz before continuing.'
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates python3 xz-utils
fi
python3 - "$setup_host" "$sync_port" "$admin_port" "$setup_port" <<'PY'
import ipaddress
import re
import socket
import sys

host = sys.argv[1]
addresses = ["127.0.0.1", "127.0.0.1"]
if host:
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        if len(host) > 253 or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", host) or re.fullmatch(r"[0-9.]+", host):
            sys.exit("Invalid --host. Provide a public IPv4 address or DNS name, without a scheme or port.")
    addresses.append("0.0.0.0")
for address, port in zip(addresses, map(int, sys.argv[2:])):
    with socket.socket() as sock:
        try:
            sock.bind((address, port))
        except OSError as exc:
            sys.exit(f"TCP port {port} is unavailable: {exc}")
PY

work=$(mktemp -d)
created=
cleanup() {
    if [ "$created" = yes ] && [ ! -f "$root/installed" ]; then
        journalctl -u "$service" -n 20 --no-pager >&2 || true
        systemctl disable --now "$service" "$service-update.timer" "$service-update.path" 2>/dev/null || true
        systemctl stop "$service-update.service" 2>/dev/null || true
        rm -f -- "$unit" "/etc/systemd/system/$service-update.service" "/etc/systemd/system/$service-update.path" "/etc/systemd/system/$service-update.timer"
        systemctl daemon-reload || true
        rm -rf -- "$root" "$data" "$control"
        userdel "$service" || true
    fi
    rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
release="$repo/releases/latest/download"
if ! python3 - "${repo#https://github.com/}" "$bundle" "$work" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

class AssetRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https" or target.hostname not in {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}:
            raise ValueError("Unexpected GitHub download host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)

repo, name, directory = sys.argv[1:]
api = f"https://api.github.com/repos/{repo}/releases"
opener = build_opener(AssetRedirect)
def fetch(url, accept):
    headers = {"User-Agent": "sgs-toolbox-sync-install", "Accept": accept, "X-GitHub-Api-Version": "2022-11-28"}
    return opener.open(Request(url, headers=headers), timeout=15)

try:
    with fetch(api + "/latest", "application/vnd.github+json") as response:
        release = json.load(response)
    [asset] = [item for item in release["assets"] if item["name"] == name]
    match = re.fullmatch(r"sha256:([a-f0-9]{64})", asset["digest"])
    size = asset["size"]
    if not match or not 0 < size < 32 * 1024 * 1024 or not isinstance(asset["id"], int):
        raise ValueError("Invalid release asset metadata")
    path = Path(directory) / name
    for attempt in range(2):
        try:
            with fetch(f"{api}/assets/{asset['id']}", "application/octet-stream") as response:
                payload = response.read(size + 1)
            if len(payload) != size or hashlib.sha256(payload).hexdigest() != match[1]:
                raise ValueError("Release asset digest mismatch")
            path.write_bytes(payload)
            path.with_suffix(path.suffix + ".sha256").write_text(f"{match[1]}  {name}\n", encoding="ascii")
            break
        except (OSError, ValueError):
            if attempt == 1:
                raise
except (KeyError, OSError, TypeError, ValueError) as exc:
    sys.exit(f"GitHub asset API unavailable ({exc}); trying the release download URL.")
PY
then
    download "$release/$bundle.sha256" "$work/$bundle.sha256"
    download "$release/$bundle" "$work/$bundle"
fi
digest=$(awk -v name="$bundle" 'NF == 2 && $2 == name { print $1 }' "$work/$bundle.sha256")
printf '%s\n' "$digest" | grep -Eq '^[0-9a-f]{64}$' || fail 'Invalid release checksum.'
printf '%s  %s\n' "$digest" "$work/$bundle" | sha256sum --check --status || fail 'Release checksum mismatch. Retry after the release has finished publishing.'
node_file="node-$node_version-linux-$arch.tar.xz"
node_url="https://nodejs.org/dist/$node_version"
download "$node_url/SHASUMS256.txt" "$work/node.sha256"
download "$node_url/$node_file" "$work/$node_file"
digest=$(awk -v name="$node_file" '$2 == name { print $1 }' "$work/node.sha256")
printf '%s\n' "$digest" | grep -Eq '^[0-9a-f]{64}$' || fail 'Invalid Node.js checksum.'
printf '%s  %s\n' "$digest" "$work/$node_file" | sha256sum --check --status || fail 'Node.js checksum mismatch.'

mkdir "$work/app" "$work/node"
tar --extract --gzip --file "$work/$bundle" --directory "$work/app" --no-same-owner --no-same-permissions
tar --extract --xz --file "$work/$node_file" --directory "$work/node" --strip-components=1 --no-same-owner --no-same-permissions
version=$("$work/node/bin/node" -p 'require(process.argv[1]).version' "$work/app/server-version.json")
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Invalid server version.'

useradd --system --user-group --no-create-home --home-dir "$data" --shell /usr/sbin/nologin "$service"
created=yes
install -d -m 755 "$root" "$root/releases"
install -d -m 700 -o "$service" -g "$service" "$data"
cp -R "$work/app" "$root/releases/v$version"
install -d -m 755 "$root/runtime"
install -m 755 "$work/node/bin/node" "$root/runtime/node"
# Releases are read-only to the service user, including the bundled dependencies.
chmod -R a+rX,go-w "$root/releases/v$version"
ln -s "$root/releases/v$version" "$root/current"
install -m 755 "$root/current/distribution/reset-linux.sh" "$root/reset-admin-password"
password=$(runuser -u "$service" -- "$root/runtime/node" "$root/current/tools/appearance-sync.mjs" --data-dir "$data" --reset-admin-password)
printf '%s\n' "$password" | grep -Eq '^A1[A-Za-z0-9_-]{43}$' || fail 'Initial administrator password creation failed.'
setup_args=
if [ -n "$setup_host" ]; then
    setup_code=$(runuser -u "$service" -- "$root/runtime/node" "$root/current/tools/appearance-sync.mjs" --data-dir "$data" --create-setup-code)
    printf '%s\n' "$setup_code" | grep -Eq '^[A-Za-z0-9_-]{43}$' || fail 'Initial setup code creation failed.'
    setup_args=" --setup-host $setup_host --setup-port $setup_port"
fi

cat > "$unit" <<EOF
[Unit]
Description=SGS OL Toolbox Sync Server
After=network.target

[Service]
User=$service
Group=$service
WorkingDirectory=$root/current
Environment=HOME=$data
ExecStart=$root/runtime/node $root/current/tools/appearance-sync.mjs --data-dir $data --port $sync_port --admin-port $admin_port$setup_args --private-network --public-network --https-admin --server-update-dir $control
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
UMask=0077
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$unit"
systemctl daemon-reload
(umask 022; sh "$root/current/distribution/install-updater.sh" "$root" "$data" "$service" "$admin_port")
systemctl enable --now "$service"
await_admin
if [ -n "$setup_host" ]; then
    setup_authority="$setup_host"
    [ "$setup_port" = 80 ] || setup_authority="$setup_host:$setup_port"
    setup_page=$(curl -fsS --noproxy '*' --max-time 5 -H "Host: $setup_authority" "http://127.0.0.1:$setup_port/admin/")
    printf '%s\n' "$setup_page" | grep -q 'data-initial-setup' || fail 'The initial setup page failed its startup check.'
fi
printf '%s %s\n' "$sync_port" "$admin_port" > "$root/installed"
printf '\nInstalled server v%s (private mode)\n' "$version"
if [ -n "$setup_host" ]; then
    printf 'First setup link (HTTP, 60 minutes): http://%s:%s/admin/\n' "$setup_host" "$setup_port"
    printf 'Setup TCP port: %s (allow your public client IP in the cloud firewall)\n' "$setup_port"
    printf 'First setup code: %s\n' "$setup_code"
fi
show_access
printf 'Initial admin password: %s\n' "$password"

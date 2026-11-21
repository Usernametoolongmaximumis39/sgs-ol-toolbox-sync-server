# 三国杀 OL 工具箱同步服务端

为工具箱同步设置、账本和战绩，也可镜像 Lite 核心与插件更新。新实例默认私有，服务器可以读取私有同步数据。公共模式允许多个用户分别绑定，工具箱在上传前加密数据，默认最多绑定 10 个账号。分享查看默认开启，查看者需要分享凭据及六位码。

[发行版与下载](https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest) · [AI Agent 操作手册](AGENTS.md) · [llms.txt](llms.txt)

## 先选私有或公共

| 使用场景 | 同步地址 | 证书要求 |
| --- | --- | --- |
| 私有，工具箱和服务在同一台电脑 | `http://127.0.0.1:17429`（默认） | 无需证书或域名 |
| 私有，自己的其他设备跨机连接 | `http://客户端可达的IPv4或域名:新端口` | HTTP 无需证书。仅在可信网络使用 HTTP，传输未加密。选择 HTTPS 时才准备证书 |
| 公共，供多个用户分别绑定 | `https://sync.example.com:8888`（示例） | 需要可解析的域名和客户端信任的 TLS 证书，提交 PEM 完整证书链及配套私钥 |

跨设备访问或填写域名时，可以继续使用私有模式。只有确定要提供公共同步时，才进入[开启公共同步](#开启公共同步)并执行不可逆的模式转换。

## 一键安装

安装程序下载此仓库最新的正式 Release，校验 SHA-256，安装专用 Node.js，并设置开机启动。Ubuntu、Debian 通过 systemd 运行，Windows Server 原生通过任务计划程序运行。

新实例默认以**私有同步**运行。安装程序默认启用 HTTP 管理页，安装后可直接在自己的电脑打开终端打印的链接。在云安全组将管理端口 TCP `17431` 放行给自己的公网 IP。主机防火墙启用时，也要放行该连接。

如果目标服务器下载 Node.js 较慢，可直接使用[通过镜像下载 Node.js](#通过镜像下载-nodejs)的命令。

### Ubuntu 或 Debian

适用 Ubuntu 22.04／24.04 LTS、Debian 12／13 等采用 systemd 的 x64 或 ARM64 主机。通过 SSH 登录服务器，执行以下命令。

```sh
installer=$(mktemp)
curl -fL --retry 3 -o "$installer" https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest/download/install-linux.sh &&
  sudo sh "$installer"
result=$?
rm -f "$installer"
test "$result" -eq 0
```

可用 `--host SERVER_PUBLIC_IP_OR_DNS` 指定管理页只接受一个 IPv4 或域名。端口冲突时可加 `--sync-port 18429 --admin-port 18430 --setup-port 18431`，其中 `--setup-port` 设置 HTTP 管理端口。安装在 `/opt/sgs-toolbox-sync`，数据在 `/var/lib/sgs-toolbox-sync`。服务名为 `sgs-toolbox-sync.service`，可用 `sudo journalctl -u sgs-toolbox-sync -n 50` 查看启动日志。

### Windows Server

适用 x64 Windows Server 2019、2022 和 2025。通过远程桌面打开 **64 位管理员 PowerShell**。

```powershell
$installer = Join-Path $env:TEMP 'sgs-install-windows.ps1'
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest/download/install-windows.ps1' -OutFile $installer
try {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  if ($LASTEXITCODE) { throw "Installer failed (exit $LASTEXITCODE)" }
}
finally { Remove-Item -LiteralPath $installer }
```

可用 `-HostName 'SERVER_PUBLIC_IP_OR_DNS'` 指定管理页只接受一个 IPv4 或域名。端口冲突时可加 `-SyncPort 18429 -AdminPort 18430 -SetupPort 18431`，其中 `-SetupPort` 设置 HTTP 管理端口。默认任务名是 `sgs-toolbox-sync`，可在「任务计划程序」查看运行状态。安装目录为 `%ProgramFiles%\sgs-toolbox-sync`，数据在其下的 `data` 目录。

在 Windows 防火墙允许首次访问时，把下方 `YOUR_PUBLIC_CLIENT_IP` 换成**操作者自己的公网 IP**。

```powershell
New-NetFirewallRule -DisplayName 'SGS HTTP admin' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17431 -RemoteAddress 'YOUR_PUBLIC_CLIENT_IP'
```

### 通过镜像下载 Node.js

目标服务器到 `nodejs.org` 下载大文件较慢时，例如在中国大陆，可以直接运行下面对应系统的命令。这里从本仓库主分支获取支持镜像参数的安装脚本，服务端运行包仍取自 GitHub 正式版。安装器从 Node.js 官网下载 `SHASUMS256.txt`，用它校验镜像中的压缩包。镜像下载失败会回退官网，校验失败会停止安装。

Ubuntu／Debian

```sh
installer=$(mktemp)
curl -fL --retry 3 -o "$installer" https://raw.githubusercontent.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/main/distribution/install-linux.sh &&
  sudo sh "$installer" --node-mirror https://npmmirror.com/mirrors/node
result=$?
rm -f "$installer"
test "$result" -eq 0
```

Windows Server 管理员 PowerShell

```powershell
$installer = Join-Path $env:TEMP ('sgs-install-' + [guid]::NewGuid() + '.ps1')
try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/main/distribution/install-windows.ps1' -OutFile $installer
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -NodeMirror 'https://npmmirror.com/mirrors/node'
    if ($LASTEXITCODE) { throw "Installer failed (exit $LASTEXITCODE)" }
}
finally {
    Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue
}
```

目标服务器仍需能访问 GitHub 和 `nodejs.org` 的校验文件。镜像参数只影响 Node.js 压缩包下载。

## 第一次打开管理面板

安装完成后，打开终端显示的 `HTTP admin link`。未指定域名时，安装程序通过 [ipify](https://www.ipify.org/) 查询公网 IPv4 用于显示链接。若输出 `SERVER_PUBLIC_IP_OR_DNS`，将其替换为云控制台显示的公网 IPv4 或服务器域名。HTTP 登录流量未加密。

| 用途 | 默认地址 | 使用的凭据 |
| --- | --- | --- |
| HTTP 管理 | `http://服务器公网地址:17431/admin/` | 管理员密码。配置全新公共实例也可用 `First setup code`，有效 60 分钟 |
| 本机应急管理 | `http://127.0.0.1:17430/admin/` | 管理员密码 |
| 初始私有同步 | `http://127.0.0.1:17429` | 工具箱的私有配对凭据 |
| 公共同步和 HTTPS 管理 | `https://同步域名:8888` 与同地址的 `/admin/` | HTTPS 管理使用管理员密码 |

## 绑定私有服务器

1. 同机使用初始同步地址 `http://127.0.0.1:17429`。跨设备使用时，在管理页「网络设置」的「域名或 IP」栏填工具箱可以访问的服务器 IPv4 或域名，例如在内网用 `192.168.1.20`。填一个空闲的新同步端口，例如 `18429`。使用私有 HTTP 时保持「SSL 证书」关闭。保存后按[更换同步地址或端口](#更换同步地址或端口)检查连通性，再用新地址配对，例如 `http://192.168.1.20:18429`。
2. 在工具箱打开「管理 → 云同步 → 私有服务器 → 四位码」。如需填写自己的地址，展开「更改私有服务器地址」，填写同步地址，再点击「生成四位配对码」。
3. 在 5 分钟内把四位码填到服务端管理页的「私有配对」，点击「生成加密凭据」。把凭据粘回发起配对的工具箱，点击「同意并绑定私有服务器」。该凭据限用一次，有效 10 分钟。
4. 工具箱提示「私有服务器绑定成功」后，核对服务端的账号和设备。主账号建立后，新设备也可先登录同一个游戏主账号，再用管理页生成的「主账号绑定凭据」配对。该凭据限用一次，有效 15 分钟。

手动部署需要跨设备私有同步时，在原启动命令中增加 `--private-network`。一键安装已经启用。

## 更换同步地址或端口

1. 先记录当前同步地址。新增或修改同步域名或 IPv4，或切换 HTTP／HTTPS，必须同时在「同步端口」填一个空闲的新端口。比如把仅本机的 `http://127.0.0.1:17429` 改为 `http://192.168.1.20:18429`。沿用旧端口会提示「更改域名或 HTTP／HTTPS 时，请填写一个新端口」（`new_port_required`）。同域名、同协议续签证书可以沿用当前端口。
2. 放行新同步端口，仅允许计划使用的客户端来源访问。云主机同时检查安全组和主机防火墙。保存后服务会监听候选端口，旧同步端口继续保留。从工具箱所在设备访问新地址的 `/health`，确认新监听可达。已有绑定时，旧地址要继续对工具箱可达，供它发现新地址。
3. 新实例在工具箱用新地址完成绑定。已有私有绑定时，在正常使用工具箱的设备上登录同一游戏账号并触发同步，让工具箱通过旧地址发现并认证新地址。公共客户端需完成一次对新地址的实际同步，例如首次绑定后拉取数据。外部同步地址需要从服务端以外的设备发起认证。`/health` 返回成功只验证连通性，管理页登录也不会启动切换计时。
4. 管理页显示「等待工具箱在新端口认证」时，旧端口会继续保留，等待无自动截止时间。首次有效认证后，管理页显示旧端口预计关闭时间。从这次认证起保留旧端口 60 分钟，随后新端口转正，旧监听释放。确认后再移除旧防火墙规则。候选地址填错时，可在管理页允许的情况下点「取消切换」再重设。

## 开启公共同步

1. 将同步域名的 DNS A 记录指向服务器公网 IPv4，为该域名签发受信任的证书。准备 PEM 格式的完整证书链和私钥，并在云安全组和主机防火墙允许选定的 HTTPS TCP 端口，例如 `8888`。
2. 使用 HTTP 管理页时，在服务器上执行下面的命令放置证书文件，把示例路径换成实际路径。私钥留在服务器上。本机应急管理和 HTTPS 管理页可以选择 PEM 文件。

   Ubuntu／Debian

   ```sh
   sudo install -o sgs-toolbox-sync -g sgs-toolbox-sync -m 600 /path/to/fullchain.pem /var/lib/sgs-toolbox-sync/setup-fullchain.pem
   sudo install -o sgs-toolbox-sync -g sgs-toolbox-sync -m 600 /path/to/privkey.pem /var/lib/sgs-toolbox-sync/setup-privkey.pem
   ```

   Windows Server 管理员 PowerShell

   ```powershell
   $data = Join-Path $env:ProgramFiles 'sgs-toolbox-sync\data'
   Copy-Item -LiteralPath 'C:\path\to\fullchain.pem' -Destination (Join-Path $data 'setup-fullchain.pem')
   Copy-Item -LiteralPath 'C:\path\to\privkey.pem' -Destination (Join-Path $data 'setup-privkey.pem')
   ```

3. 在「网络设置」填写同步域名和不同于旧端口的 HTTPS **同步端口**，启用「SSL 证书」，点击「保存网络设置」。从服务器外访问 `https://同步域名:端口/health`。收到 HTTP 200 和 `"ok":true` 表示同步端口已走通，此时 `mode` 仍是 `private`。已有私有绑定可在准备历史时认证新端口。全新实例可以先转公共，再由首位已绑定的工具箱实际同步来确认新端口。端口何时转正见[更换同步地址或端口](#更换同步地址或端口)。
4. 已有私有历史时，用管理员密码管理实例。分别登录每个有历史的游戏账号，在工具箱「云同步」选择「准备转为公共模式」，等后台显示历史均已就绪。若有移除账号处于 30 天恢复期，先恢复账号或等待恢复期结束。全新实例可以直接进入下一步。
5. 展开「转为公共服务器」，输入 `转为公共` 并确认。转换会停用旧私有授权并清理服务在线使用的明文历史。这一步不可逆。所有已准备账号随后应在工具箱点击「启用已准备的公共连接」，并保存公共恢复凭据。
6. 再访问同步地址的 `/health`，确认 `mode` 是 `public`。此时可以打开 HTTPS 管理页，默认路径 `/admin/`，已改过路径就使用当前路径。浏览器信任证书后再用管理员密码登录。首次成功登录 HTTPS 后台会使首次设置码失效。HTTP 管理入口仍由「管理入口」中的开关控制。使用文件配置证书的实例验证完成后，可以删除第 2 步复制的两份临时 PEM。
7. 新用户在工具箱「管理 → 云同步 → 公共服务器」填写 HTTPS 同步地址并完成绑定。核对工具箱能实际同步。管理员可在后台调整绑定上限和分享开关。

## 关闭 HTTP 管理或更换路径

用管理员密码登录后打开「管理入口」。关闭「允许公网 HTTP 管理」并保存，服务立即释放 HTTP 管理端口。修改「公网管理路径」并保存，新路径同时用于公网 HTTP 和 HTTPS 管理，原路径立即失效。路径由一个以小写字母开头的片段组成，可含数字、下划线或连字符，例如 `/control/`。公共同步地址和服务探针 `/health` 使用各自的路径。

HTTP 端口修改后，在云安全组和主机防火墙放行新端口。旧实例升级时也能从「管理入口」启用 HTTP。误关闭时可从 HTTPS 后台，或在服务器本机打开 `http://127.0.0.1:17430/admin/`，重新启用入口。

## 修改或重置管理员密码

登录正式管理面板后，在「管理员密码」填写当前密码并设置新密码。新密码为 8–128 位，必须包含英文字母与数字，支持标点。保存后现有管理会话全部失效。密码文件保存的是带盐的散列。

忘记密码时，在服务器终端执行下列命令。服务会短暂重启，终端显示新密码，保留账号、证书与同步数据。

Ubuntu／Debian

```sh
sudo /opt/sgs-toolbox-sync/reset-admin-password
```

Windows Server 管理员 PowerShell

```powershell
$maintenance = Join-Path $env:ProgramFiles 'sgs-toolbox-sync\install-windows.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $maintenance -ResetPassword
```

通过源码手动部署的实例，先停止服务，再在原数据目录执行 `node tools/appearance-sync.mjs --data-dir /path/to/data --reset-admin-password` 并重新启动。老实例升级后仍可用原密码登录和修改。

## 排查同步连接

| 现象 | 处理方式 |
| --- | --- |
| 保存域名或协议时提示 `new_port_required` | 选一个与当前同步端口不同且空闲的端口，检查管理端口、现有监听和防火墙。 |
| 新端口 `/health` 正常，后台一直等待认证 | 在实际工具箱上完成绑定或触发同步。外部地址从另一台设备验证。后台出现旧端口关闭时间，表示 60 分钟保留期已经开始。 |
| HTTPS 的 `/health` 可访问，管理页打不开 | 确认 `mode` 已为 `public`，再检查当前后台路径。手动部署还需核对 `--https-admin`。 |

## 接管观星

管理页「自助观星」中的「接管观星」默认开启。已绑定此服务器的工具箱客户端（核心 0.6.213 起）打开或刷新观星窗口时，从同步服务器读取报表。服务端从 [观星站](https://gx.95chong.cn/) 匿名读取并共享缓存，有效报表会保留来源更新时间。关闭接管后，客户端在下一次读取时恢复直连观星站。

## 增量同步

首次下载完整备份后，支持增量同步的客户端按游标拉取账本、战绩和设置的变化。增量拉取不占用完整备份的下载额度。私有和公共模式均支持，公共模式继续以密文存储记录。私有实例升级时会导入原有历史，保留旧文件备份。

## 更新服务端

- **Ubuntu／Debian 一键安装**在后台「服务端自更新」里检查和安装新版。更新会短暂重启，健康检查失败时回退。
- **Windows Server 一键安装**重新执行安装命令下载正式版。检查通过后切换任务版本，保留原密码、端口和数据。新版本启动失败时恢复原任务版本。
- 手动安装需要 Node.js 22.13 或更新版本。源码目录中执行 `npm ci` 和 `npm start -- --http-admin`，数据目录为 `data/appearance-sync`；首次密码可在数据目录的 `admin-token` 中读取。Linux systemd 手工安装若需自更新，可用 `sh distribution/install-updater.sh INSTALL_ROOT DATA_DIR SERVICE_NAME ADMIN_PORT`，将打印的目录传给 `--server-update-dir`。

「更新镜像」管理工具箱的 Lite 核心与插件更新包。「服务端自更新」更新同步服务进程。公共地址的 `/health` 可独立检查同步服务是否在线。

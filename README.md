# 三国杀 OL 工具箱同步服务端

为工具箱提供私有或公共加密同步，也可镜像 Lite 核心与插件更新。公共服务强制 HTTPS，默认最多绑定 10 个账号。分享查看默认开启，查看者需要分享凭据及六位码。

[发行版与下载](https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest) · [AI Agent 操作手册](AGENTS.md) · [llms.txt](llms.txt)

## 一键安装

安装程序下载此仓库最新的正式 Release，校验 SHA-256，安装专用 Node.js，并设置开机启动。Ubuntu、Debian 通过 systemd 运行，Windows Server 原生通过任务计划程序运行。

新实例默认以**私有同步**运行。安装程序默认启用 HTTP 管理页，安装后可直接在自己的电脑打开终端打印的链接。在云安全组将管理端口 TCP `17431` 放行给自己的公网 IP。主机防火墙启用时，也要放行该连接。

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

## 第一次打开管理面板

安装完成后，打开终端显示的 `HTTP admin link`。未指定域名时，安装程序通过 [ipify](https://www.ipify.org/) 查询公网 IPv4 用于显示链接。若输出 `SERVER_PUBLIC_IP_OR_DNS`，将其替换为云控制台显示的公网 IPv4 或服务器域名。HTTP 登录流量未加密。

| 用途 | 默认地址 | 使用的凭据 |
| --- | --- | --- |
| HTTP 管理 | `http://服务器公网地址:17431/admin/` | 管理员密码。首次配置也可用 `First setup code`，有效 60 分钟 |
| 本机应急管理 | `http://127.0.0.1:17430/admin/` | 管理员密码 |
| 初始私有同步 | `http://127.0.0.1:17429` | 工具箱的私有配对凭据 |
| 公共同步和 HTTPS 管理 | `https://同步域名:8888` 与同地址的 `/admin/` | HTTPS 管理使用管理员密码 |

### 开启公共同步

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

3. 登录终端打印的管理页。在「网络设置」填同步域名与 HTTPS 端口，打开「SSL 证书」并保存。证书有效且服务成功监听后，同步自动强制 HTTPS，此时才可展开「转为公共服务器」，输入「转为公共」并确认。已有私有数据时，先按工具箱和后台的提示准备加密历史。
4. 打开 `https://同步域名:端口/admin/`，确认浏览器信任该证书，再输入管理员密码。首次设置码在这次登录后失效，HTTP 管理地址继续可用。确认公共服务可用后，可以删除数据目录里的两份临时证书文件。
5. 用户在工具箱「云同步」中填写 HTTPS 同步地址。管理员可在后台调整绑定上限和分享开关。

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

## 更新服务端

- **Ubuntu／Debian 一键安装**在后台「服务端自更新」里检查和安装新版。更新会短暂重启，健康检查失败时回退。
- **Windows Server 一键安装**重新执行安装命令下载正式版。检查通过后切换任务版本，保留原密码、端口和数据。新版本启动失败时恢复原任务版本。
- 手动安装需要 Node.js 22.13 或更新版本。源码目录中执行 `npm ci` 和 `npm start -- --http-admin`，数据目录为 `data/appearance-sync`；首次密码可在数据目录的 `admin-token` 中读取。Linux systemd 手工安装若需自更新，可用 `sh distribution/install-updater.sh INSTALL_ROOT DATA_DIR SERVICE_NAME ADMIN_PORT`，将打印的目录传给 `--server-update-dir`。

「更新镜像」管理工具箱的 Lite 核心与插件更新包。「服务端自更新」更新同步服务进程。公共地址的 `/health` 可独立检查同步服务是否在线。

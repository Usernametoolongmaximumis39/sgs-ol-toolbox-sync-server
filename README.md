# 三国杀 OL 工具箱同步服务端

为工具箱提供私有或公共加密同步，也可镜像 Lite 核心与插件更新。公共服务强制 HTTPS，默认最多绑定 10 个账号。分享查看默认开启，查看者需要分享凭据及六位码。

[发行版与下载](https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest) · [AI Agent 操作手册](AGENTS.md) · [llms.txt](llms.txt)

## 一键安装

安装程序下载此仓库最新的正式 Release，校验 SHA-256，安装专用 Node.js，并设置开机启动。Ubuntu、Debian 通过 systemd 运行，Windows Server 原生通过任务计划程序运行。

首次安装前，在云安全组中允许**自己的公网 IP**访问 TCP `17431`。Windows 主机防火墙也需要允许同一连接。若改了首次设置端口，按实际端口开放。新实例用公网 IPv4 或已经解析的域名作为安装参数。

### Ubuntu 或 Debian

适用 Ubuntu 22.04／24.04 LTS、Debian 12／13 等采用 systemd 的 x64 或 ARM64 主机。通过 SSH 登录服务器，执行以下命令。把 `SERVER_PUBLIC_IP_OR_DNS` 换成服务器的公网 IPv4 或域名，保持同一行的参数连在一起。

```sh
installer=$(mktemp)
curl -fL --retry 3 -o "$installer" https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest/download/install-linux.sh &&
  sudo sh "$installer" --host SERVER_PUBLIC_IP_OR_DNS
result=$?
rm -f "$installer"
test "$result" -eq 0
```

端口冲突时，可加 `--sync-port 18429 --admin-port 18430 --setup-port 18431`。安装在 `/opt/sgs-toolbox-sync`，数据在 `/var/lib/sgs-toolbox-sync`。服务名为 `sgs-toolbox-sync.service`，可用 `sudo journalctl -u sgs-toolbox-sync -n 50` 查看启动日志。

### Windows Server

适用 x64 Windows Server 2019、2022 和 2025。通过远程桌面打开 **64 位管理员 PowerShell**。把 `SERVER_PUBLIC_IP_OR_DNS` 换成服务器的公网 IPv4 或域名。

```powershell
$installer = Join-Path $env:TEMP 'sgs-install-windows.ps1'
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server/releases/latest/download/install-windows.ps1' -OutFile $installer
try {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -HostName 'SERVER_PUBLIC_IP_OR_DNS'
  if ($LASTEXITCODE) { throw "Installer failed (exit $LASTEXITCODE)" }
}
finally { Remove-Item -LiteralPath $installer }
```

端口冲突时，可加 `-SyncPort 18429 -AdminPort 18430 -SetupPort 18431`。默认任务名是 `sgs-toolbox-sync`，可在「任务计划程序」查看运行状态。安装目录为 `%ProgramFiles%\sgs-toolbox-sync`，数据在其下的 `data` 目录。

在 Windows 防火墙允许首次访问时，把下方 `YOUR_PUBLIC_CLIENT_IP` 换成**操作者自己的公网 IP**。

```powershell
New-NetFirewallRule -DisplayName 'SGS first setup' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17431 -RemoteAddress 'YOUR_PUBLIC_CLIENT_IP'
```

## 第一次打开管理面板

安装结束后，终端会显示首次设置网址和设置码、管理员密码以及端口。设置码和密码请保存在自己的密码管理器中。

| 用途 | 默认地址 | 使用的凭据 |
| --- | --- | --- |
| 安装后首次网页设置 | `http://服务器公网地址:17431/admin/` | 终端的 `First setup code`，有效 60 分钟 |
| 回环管理 | `http://127.0.0.1:17430/admin/` | 终端的 `Initial admin password` |
| 初始私有同步 | `http://127.0.0.1:17429` | 工具箱的私有配对凭据 |
| 公共同步和 HTTPS 管理 | `https://同步域名:8888` 与同地址的 `/admin/` | HTTPS 管理使用管理员密码 |

### 开启公共同步

1. 将同步域名的 DNS A 记录指向服务器公网 IPv4，为该域名签发受信任的证书。准备 PEM 格式的完整证书链和私钥，并在云安全组和主机防火墙允许选定的 HTTPS TCP 端口，例如 `8888`。
2. 在服务器上执行下面对应系统的命令，放置证书文件。把示例路径换成证书的实际路径。私钥留在服务器上。

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

3. 在自己的电脑浏览器打开安装程序打印的 HTTP 地址，输入 `First setup code`。在「网络设置」填同步域名与 HTTPS 端口，点「保存网络设置」。展开「转为公共服务器」，输入「转为公共」并确认。
4. 点击「打开 HTTPS 管理面板」，确认浏览器信任该证书，再输入管理员密码。成功登录后，服务立即关闭首次 HTTP 入口，可撤销安全组和主机防火墙中的首次设置端口规则。确认公共服务可用后，可以删除数据目录里的两份临时证书文件。
5. 用户在工具箱「云同步」中填写 HTTPS 同步地址。管理员可在后台调整绑定上限和分享开关。

仅使用私有同步、首次设置码已过期或需要故障排查时，直接用回环管理页。Windows 在服务器的远程桌面中打开回环网址。Ubuntu／Debian 可以在自己的电脑运行 `ssh -N -L 17430:127.0.0.1:17430 USER@SERVER`，保持 SSH 窗口打开，再在浏览器打开 `http://127.0.0.1:17430/admin/`。SSH 转发的本地端口要与服务的回环管理端口相同。回环管理页允许直接选择 PEM 文件。

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
- 手动安装需要 Node.js 22.13 或更新版本。源码目录中执行 `npm ci` 和 `npm start`，默认回环访问，数据目录 `data/appearance-sync`。Linux systemd 手工安装若需自更新，可用 `sh distribution/install-updater.sh INSTALL_ROOT DATA_DIR SERVICE_NAME ADMIN_PORT`，将打印的目录传给 `--server-update-dir`。

「更新镜像」管理工具箱的 Lite 核心与插件更新包。「服务端自更新」更新同步服务进程。公共地址的 `/health` 可独立检查同步服务是否在线。

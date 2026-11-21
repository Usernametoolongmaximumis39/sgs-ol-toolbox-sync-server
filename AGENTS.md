# AI Agent 操作手册

这是**三国杀 OL 工具箱同步服务端**仓库。它运行同步服务和自己的管理面板。工具箱客户端、插件市场、兑换码和审核服务器各自独立。

## 先判断用户的任务

| 用户要做什么 | 按哪里走 |
| --- | --- |
| 在新云服务器安装 | [一键安装](README.md#一键安装)。先确认操作系统。安装默认私有、回环访问。操作者需要公网 HTTP 首设时才传入公网 IPv4 或域名。 |
| 浏览器首次打开 | 默认用终端打印的回环网址和管理员密码。传入公网地址的安装会额外输出 `First setup link`，通常是 `http://公网地址:17431/admin/`，使用有效 60 分钟的 `First setup code`。 |
| 已有服务登录 | 用既有 HTTPS 管理网址，末尾是 `/admin/`。环回维护地址为 `http://127.0.0.1:17430/admin/`。 |
| 配置公共同步／证书 | [开启公共同步](README.md#开启公共同步)。准备 DNS A 记录、受信任的 PEM 完整证书链和私钥、公网 HTTPS 端口。 |
| 忘记正式管理密码 | [修改或重置管理员密码](README.md#修改或重置管理员密码)。按系统执行已安装的本地重置命令。 |
| 更新服务器软件 | [更新服务端](README.md#更新服务端)。Linux 从后台更新，Windows 重跑安装命令。 |

## 执行前读懂三种地址

1. `17431` 是临时公开 HTTP 设置入口，云安全组与 Windows 主机防火墙只放行操作者的公网 IP。使用首次设置码。正式管理员密码和 PEM 私钥都留在 HTTPS、回环或服务器终端操作。首次成功登录 HTTPS 管理页或 60 分钟到期会关闭此入口。
2. `17430` 是服务器自己的回环管理端口。用户通过 RDP 在 Windows 服务器内开网页，或在自己电脑使用 `ssh -N -L 17430:127.0.0.1:17430 USER@SERVER`。SSH 转发两边使用同一管理端口。云安全组无需放行 17430。
3. `17429` 是新实例的回环同步端口。公网同步使用用户配置的 HTTPS 端口，例如 8888。工具箱填写 `https://域名:端口`，管理员访问同地址的 `/admin/`，在线检测使用同地址的 `/health`。

自定义端口以安装输出为准。公共 HTTPS 需要域名，首次设置可以使用公网 IPv4。设置码过期从回环继续。通过 HTTP 首次设置时，只在服务器上把证书文件放为 `setup-fullchain.pem` 和 `setup-privkey.pem`，路径与权限照 README 里的系统命令。SSL 证书有效且 HTTPS 监听成功后，服务自动要求 HTTPS，此时才允许转公共。已有私有数据的实例在切换到公共模式前，要按后台提示准备加密历史。

## 安装和故障定位

- Ubuntu／Debian 选择 `install-linux.sh`，在目标服务器运行，需要 sudo。默认 systemd 服务 `sgs-toolbox-sync.service`。用 `systemctl status sgs-toolbox-sync` 和 `sudo journalctl -u sgs-toolbox-sync -n 50` 查看状态。
- Windows Server 选择 `install-windows.ps1`，在目标服务器的 64 位管理员 PowerShell 运行。用 `Get-ScheduledTask -TaskName sgs-toolbox-sync` 查看任务。默认目录 `%ProgramFiles%\sgs-toolbox-sync`。
- 首次网址打不开时，先核对实际公网地址、TCP 端口、云安全组、主机防火墙和 60 分钟有效期。服务器本机回环管理页可独立排查启动问题。若 HTTPS 访问失败，核对 DNS、证书域名与有效期、证书链以及公网 HTTPS 端口。
- 正式改密要求当前密码和新密码。新密码为 8–128 位，至少一个英文字母和一个数字。改密或离线重置后都要重新登录。安装与重置输出的密码由用户保存。给用户汇报执行结果时省略实际密码、设置码和私钥。
- 重置和更新使用原实例、原端口和原数据目录。确认目标实例再执行。Linux 数据目录默认为 `/var/lib/sgs-toolbox-sync`，Windows 数据目录是安装目录下的 `data`。已有服务需保留该目录。Linux 的「服务端自更新」与「更新镜像」是两个功能。

## 仓库结构与本地验证

- `README.md` 提供用户命令。`llms.txt` 提供可索引链接。
- `distribution/install-linux.sh` 和 `distribution/install-windows.ps1` 是发行版的安装入口。Release 附件必须包含这两份脚本、`sgs-ol-toolbox-sync-server.tar.gz` 与对应的 `.sha256`。从仓库根目录执行 `npm ci`、`npm test`、`npm run pack:release`。
- `tools/appearance-sync.mjs` 是运行入口。`tools/sync-admin/` 放同步和后台实现。`server-version.json` 是正在运行的服务版本。

# AI Agent 操作手册

这是**三国杀 OL 工具箱同步服务端**仓库。它运行同步服务和自己的管理面板。工具箱客户端、插件市场、兑换码和审核服务器各自独立。

## 先判断用户的任务

私有是新实例的默认模式。只给自己或同组账号用，按私有流程交付。同机私有 HTTP 无需域名或证书，跨设备私有 HTTP 可以用客户端可达的 IPv4 或域名，保持「SSL 证书」关闭。HTTP 传输未加密，限可信网络使用。用户可以明确选择私有 HTTPS。仅收到「远程连接」或「加域名」的要求时，继续走私有流程。只有用户明确要求提供公共同步，才准备受信任的域名证书，并按 README 完成不可逆的模式转换。

| 用户要做什么 | 按哪里走 |
| --- | --- |
| 在新云服务器安装 | [一键安装](README.md#一键安装)。确认操作系统。安装默认使用私有同步，并开放 HTTP 管理端口。Node.js 下载慢时直接使用[镜像安装命令](README.md#通过镜像下载-nodejs)。 |
| 浏览器首次打开 | 直接打开终端的 `HTTP admin link`，通常是 `http://公网地址:17431/admin/`。用管理员密码登录。只有通过公网 HTTP 配置全新公共实例时才使用有效 60 分钟的 `First setup code`。 |
| 已有服务登录 | 使用当前的 HTTP 或 HTTPS 管理网址。默认路径 `/admin/`，以「管理入口」所保存的路径为准。 |
| 配对私有工具箱 | [绑定私有服务器](README.md#绑定私有服务器)。完成后核对工具箱绑定状态和后台设备。 |
| 更换同步地址或端口 | [更换同步地址或端口](README.md#更换同步地址或端口)。域名、IPv4 或 HTTP／HTTPS 有变化时同时换端口。 |
| 配置公共同步／证书 | [开启公共同步](README.md#开启公共同步)。准备 DNS A 记录、受信任的 PEM 完整证书链和私钥、公网 HTTPS 端口。 |
| 忘记正式管理密码 | [修改或重置管理员密码](README.md#修改或重置管理员密码)。按系统执行已安装的本地重置命令。 |
| 更新服务器软件 | [更新服务端](README.md#更新服务端)。Linux 从后台更新，Windows 重跑安装命令。 |

## 执行前读懂三种地址

1. `17431` 是默认的长期 HTTP 管理端口。云安全组和主机防火墙按操作者的公网 IP 放行。首次设置码有效 60 分钟，HTTPS 后台首次成功登录也会使其失效，此后可用管理员密码登录相同 HTTP 地址。
2. `17430` 是服务器本机的应急管理端口。公网 HTTP 已关闭且 HTTPS 无法访问时，在服务器本机打开 `http://127.0.0.1:17430/admin/`，重新启用 HTTP 或修正路径。
3. `17429` 是新实例的回环同步端口。公网同步使用用户配置的 HTTPS 端口，例如 8888。工具箱填写 `https://域名:端口`，管理员访问同地址的 `/admin/`，在线检测使用同地址的 `/health`。

自定义端口以安装输出为准。需要主动关闭 HTTP 管理或修改公网路径时，用正式管理员密码登录，保存「管理入口」。公网路径修改会同时作用于 HTTP 和 HTTPS 后台。公共 HTTPS 需要域名，首次设置可以使用公网 IPv4。通过 HTTP 管理配置证书时，只在服务器上放置 `setup-fullchain.pem` 和 `setup-privkey.pem`，路径与权限照 README 里的系统命令。SSL 证书有效且 HTTPS 监听成功后，同步自动要求 HTTPS，此时才允许转公共。已有私有数据的实例在切换前要准备加密历史。公共模式启用后，核对 `/health` 返回 `"mode":"public"`、HTTPS 后台能登录、真实工具箱能同步。

## 安装和故障定位

- **Node.js 下载慢时**，使用 README 中对应系统的镜像命令。镜像只提供 Node.js 压缩包，SHA-256 表仍从官网获取，校验不通过时停止。按下载输出分别定位 GitHub 运行包、Node.js 官方校验文件和镜像压缩包。
- **同步端口待确认时**，保留旧地址，从真实工具箱绑定或触发同步。对外监听需要在服务端以外的设备认证。`/health` 和后台登录只验证各自入口可达。后台仍显示等待时，向用户交付待确认状态和客户端操作。首次认证后才开始 60 分钟保留期。
- Ubuntu／Debian 选择 `install-linux.sh`，在目标服务器运行，需要 sudo。默认 systemd 服务 `sgs-toolbox-sync.service`。用 `systemctl status sgs-toolbox-sync` 和 `sudo journalctl -u sgs-toolbox-sync -n 50` 查看状态。
- Windows Server 选择 `install-windows.ps1`，在目标服务器的 64 位管理员 PowerShell 运行。用 `Get-ScheduledTask -TaskName sgs-toolbox-sync` 查看任务。默认目录 `%ProgramFiles%\sgs-toolbox-sync`。
- HTTP 网址打不开时，核对实际公网地址、TCP 端口、管理路径、云安全组和主机防火墙。60 分钟期限只适用于设置码。若 HTTPS 访问失败，核对 DNS、证书域名与有效期、证书链以及公网 HTTPS 端口。
- 正式改密要求当前密码和新密码。新密码为 8–128 位，至少一个英文字母和一个数字。改密或离线重置后都要重新登录。安装与重置输出的密码由用户保存。给用户汇报执行结果时省略实际密码、设置码和私钥。
- 重置和更新使用原实例、原端口和原数据目录。确认目标实例再执行。Linux 数据目录默认为 `/var/lib/sgs-toolbox-sync`，Windows 数据目录是安装目录下的 `data`。已有服务需保留该目录。Linux 的「服务端自更新」与「更新镜像」是两个功能。

## 仓库结构与本地验证

- `README.md` 提供用户命令。`llms.txt` 提供可索引链接。
- `distribution/install-linux.sh` 和 `distribution/install-windows.ps1` 是发行版的安装入口。Release 附件必须包含这两份脚本、`sgs-ol-toolbox-sync-server.tar.gz` 与对应的 `.sha256`。从仓库根目录执行 `npm ci`、`npm test`、`npm run pack:release`。
- `tools/appearance-sync.mjs` 是运行入口。`tools/sync-admin/` 放同步和后台实现。`server-version.json` 是正在运行的服务版本。

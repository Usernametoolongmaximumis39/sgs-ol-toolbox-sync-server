# 三国杀 OL 工具箱同步服务端

为工具箱提供私有同步或公共加密同步，也可以镜像 Lite 核心和插件更新。公共模式使用 HTTPS，用户可以凭分享凭据和六位码查看已分享的流水与战绩。管理员可以随时关闭公共预览，并限制允许绑定的账号数。

## 启动

需要 Node.js 22.13 或更新版本。解压 GitHub Release 附件后运行 `npm start`，或者从源码运行 `npm ci` 和 `npm start`。默认只接受本机连接。数据位于 `data/appearance-sync`，管理页为 `http://127.0.0.1:17430/admin/`。使用启动日志指向的数据目录中的 `admin-token` 登录。

自建公共服务时，为域名准备证书链与私钥，在管理页配置 HTTPS 后再转换为公共模式。有私有历史时，先在每个使用过的账号上准备加密历史。使用 `--public-network` 允许公共模式接收外网连接。初次配置公开域名时可使用 `--private-network`。使用 `--https-admin` 可在同步域名的 HTTPS 地址打开后台。

## 服务端自更新

后台的「服务端自更新」显示运行版本和 GitHub 正式版本。由 Linux systemd 管理的实例可以在后台安装新版本。安装会短暂重启服务，之后需要重新登录。

需要由维护者启用更新器的 systemd 单元。安装目录使用管理员所有的 `current` 符号链接指向 `releases/` 内的运行版本，服务以专用非 root 用户运行。把数据目录放在发布目录外，并保留回环管理端口供健康检查。运行 `sh distribution/install-updater.sh INSTALL_ROOT DATA_DIR SERVICE_NAME ADMIN_PORT` 后，将打印出的更新目录传给服务的 `--server-update-dir` 选项。容器安装需把该目录挂载到容器中，再将容器内路径传给该选项。

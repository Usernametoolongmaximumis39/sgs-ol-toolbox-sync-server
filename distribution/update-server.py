"""Update a managed sync server to an authenticated GitHub Release."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

REPO = "Usernametoolongmaximumis39/sgs-ol-toolbox-sync-server"
ASSET = "sgs-ol-toolbox-sync-server.tar.gz"
MAX_DOWNLOAD = 12 * 1024 * 1024
TAG = re.compile(r"v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\Z")


def version(value):
    match = TAG.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError("GitHub 版本格式无效")
    return tuple(map(int, match.groups()))


class ReleaseRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urlsplit(newurl)
        if (url.scheme != "https" or url.netloc not in
                {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}):
            raise ValueError("GitHub 发布附件的跳转地址无效")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def latest():
    request = Request(f"https://api.github.com/repos/{REPO}/releases/latest",
                      headers={"Accept": "application/vnd.github+json", "User-Agent": "sgs-sync-server-updater"})
    with urlopen(request, timeout=15) as response:
        if response.geturl() != request.full_url:
            raise ValueError("GitHub 版本接口发生意外跳转")
        data = json.loads(response.read(256 * 1024))
    tag = data["tag_name"]
    version(tag)
    if data["draft"] or data["prerelease"]:
        raise ValueError("GitHub 未提供正式版本")
    asset = next((item for item in data["assets"] if item["name"] == ASSET), None)
    url = f"https://github.com/{REPO}/releases/download/{tag}/{ASSET}"
    if (not asset or not isinstance(asset.get("id"), int) or asset["id"] <= 0
            or asset["browser_download_url"] != url or not 0 < asset["size"] <= MAX_DOWNLOAD
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest") or "")):
        raise ValueError("GitHub 正式附件缺少可用的大小或摘要")
    return tag, asset


def download(asset, target):
    api = f"https://api.github.com/repos/{REPO}/releases/assets/{asset['id']}"
    opener = build_opener(ReleaseRedirect)
    deadline = time.monotonic() + 300
    for url in (api, api, asset["browser_download_url"]):
        request = Request(url, headers={"Accept": "application/octet-stream", "User-Agent": "sgs-sync-server-updater"})
        try:
            download_from(opener, request, asset, target, deadline)
            return
        except OSError as error:
            cause = error
            target.unlink(missing_ok=True)
    raise RuntimeError("连接 GitHub 发布附件失败，请重试") from cause


def download_from(opener, request, asset, target, deadline):
    digest = hashlib.sha256()
    length = 0
    with opener.open(request, timeout=45) as source, target.open("xb") as output:
        if source.headers.get_content_type() == "application/json":
            raise OSError("The GitHub asset API did not return the archive")
        while chunk := source.read(65536):
            length += len(chunk)
            if length > asset["size"] or time.monotonic() > deadline:
                raise ValueError("发布附件超过大小或下载时限")
            digest.update(chunk)
            output.write(chunk)
    if length != asset["size"] or "sha256:" + digest.hexdigest() != asset["digest"]:
        raise ValueError("发布附件摘要校验失败")


def extract(archive, destination, tag):
    total = 0
    with tarfile.open(archive, "r:gz") as bundle:
        for index, member in enumerate(bundle):
            relative = PurePosixPath(member.name)
            total += member.size
            if (index >= 5000 or total > 32 * 1024 * 1024 or relative.is_absolute()
                    or ".." in relative.parts or (not member.isfile() and not member.isdir())):
                raise ValueError("发布附件包含不受支持的条目")
            path = destination.joinpath(*relative.parts)
            if member.isdir():
                path.mkdir(mode=0o755, parents=True, exist_ok=True)
                continue
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, path.open("xb") as output:
                shutil.copyfileobj(source, output)
    if installed_version(destination) != tag or not (destination / "tools/appearance-sync.mjs").is_file():
        raise ValueError("发布附件的服务端版本不匹配")


def installed_version(directory):
    return "v" + json.loads((directory / "server-version.json").read_text())["version"]


def health(port):
    for _ in range(15):
        try:
            with urlopen(f"http://127.0.0.1:{port}/admin/", timeout=2) as response:
                if response.status == 200 and b'id="login"' in response.read(65536):
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError("服务端重启后的健康检查未通过")


def activate(root, target):
    link = root / "current.next"
    link.symlink_to(target)
    link.replace(root / "current")


def install(args, tag, asset):
    old = (args.root / "current").resolve(strict=True)
    releases = (args.root / "releases").resolve(strict=True)
    if old.parent != releases:
        raise ValueError("当前运行版本不在受管理的发布目录")
    with tempfile.TemporaryDirectory(dir=releases) as work:
        archive = Path(work) / ASSET
        procedure = Path(work) / "app"
        procedure.mkdir(mode=0o755)
        download(asset, archive)
        extract(archive, procedure, tag)
        target = releases / (tag + "-" + asset["digest"][7:19] + "-" + Path(work).name)
        procedure.replace(target)
    activate(args.root, target)
    try:
        subprocess.run(["systemctl", "restart", args.service], check=True, timeout=60)
        health(args.admin_port)
    except (OSError, RuntimeError, subprocess.SubprocessError):
        activate(args.root, old)
        subprocess.run(["systemctl", "restart", args.service], check=True, timeout=60)
        health(args.admin_port)
        raise RuntimeError("新版本启动失败，已恢复上一版")


def take_request(directory):
    source = directory / "requests" / "update.json"
    taken = directory / ".request"
    try:
        source.replace(taken)
    except FileNotFoundError:
        return {}
    try:
        fd = os.open(taken, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise ValueError("更新请求不是普通文件")
            request = json.loads(file.read(256))
        if request.get("action") not in ("check", "install"):
            raise ValueError("更新请求格式无效")
        return request
    finally:
        taken.unlink(missing_ok=True)


def report(directory, phase, **fields):
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False, encoding="utf8") as output:
        json.dump({"phase": phase, **fields}, output)
        name = Path(output.name)
    name.chmod(0o644)
    name.replace(directory / "status.json")


def run(args):
    try:
        report(args.control, "checking")
        request = take_request(args.control)
        current = installed_version(args.root / "current")
        tag, asset = latest()
        details = {"latest": tag[1:], "checkedAt": round(time.time() * 1000)}
        if version(tag) <= version(current):
            report(args.control, "up_to_date", **details)
            return
        if request.get("action") != "install":
            report(args.control, "available", **details)
            return
        if request.get("version") != tag[1:]:
            report(args.control, "available", **details)
            return
        report(args.control, "installing", **details)
        install(args, tag, asset)
        report(args.control, "up_to_date", **details)
    except (ValueError, KeyError, AttributeError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else "检查或安装服务端更新失败"
        report(args.control, "failed", error=message, checkedAt=round(time.time() * 1000))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("control", type=Path)
    parser.add_argument("service")
    parser.add_argument("admin_port", type=int)
    run(parser.parse_args())

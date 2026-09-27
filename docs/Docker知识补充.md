# Docker 知识补充

本文结合 `geli` 项目，说明 Docker 镜像、容器、数据卷、网络、端口、资源限制和安全隔离。

## 1. Docker 基本组成

### 镜像 Image

镜像是创建容器的模板，包含操作系统文件、运行时、依赖和默认命令。本项目用户镜像由 `deploy/images/Dockerfile` 定义，基础镜像为 `node:22-bookworm-slim`。

```bash
docker build -t lab/dev:test -f deploy/images/Dockerfile .
docker images
docker image inspect <image>
```

### 容器 Container

容器是镜像的运行实例。本项目中的容器包括 PostgreSQL、Redis 和用户开发容器 `lab-<uuid>`。

```bash
docker ps
docker ps -a
docker start <container>
docker stop <container>
docker restart <container>
docker rm <container>
```

macOS 上通常由 Docker Desktop 通过 Linux 虚拟机运行 Docker Engine，因此 Docker Volume 和 `tmpfs` 位于 Docker Desktop 管理的 Linux 环境中。

## 2. Dockerfile 和开发镜像

`deploy/images/Dockerfile` 安装 Node.js、Python、Java、Git、npm/pip 工具和 `ps`、`top` 等命令，并创建 UID/GID 为 `1000` 的 `developer` 用户。

```dockerfile
WORKDIR /home/developer
USER 1000:1000
CMD ["sleep", "infinity"]
```

容器默认保持运行，平台才能通过 Web Terminal 连接。

首次 `npm run demo` 会下载 `node:22-bookworm-slim`、`postgres:15-alpine` 和 `redis:6-alpine`。遇到 `x509` 或 `failed to fetch anonymous token` 时，通常是代理、证书或 Docker Desktop 网络配置问题，不建议关闭 TLS 校验。

## 3. 容器生命周期

```text
申请 → 审批 → 创建 → RUNNING → STOPPED / RESTART → DELETED
```

```bash
docker stop <container>   # 停止但保留容器
docker start <container>  # 启动已停止容器
docker restart <container>
docker rm <container>     # 删除容器
```

本项目删除用户容器时会停止并删除容器、删除容器网络，但保留用户数据卷。

## 4. 数据存储类型

| 类型 | 说明 | 容器删除后 |
| --- | --- | --- |
| Named Volume | Docker 管理的命名卷 | 通常保留 |
| Anonymous Volume | 自动生成名称的卷 | 通常保留但不易管理 |
| Bind Mount | 映射宿主机目录 | 宿主机文件保留 |
| `tmpfs` | 内存临时盘 | 重启或卸载后可能丢失 |
| 容器可写层 | 容器自身临时文件层 | 删除容器后丢失 |

```bash
docker volume ls
docker volume inspect <volume>
docker system df -v
```

## 5. 本项目的卷

用户容器的 `/home/developer` 使用 `local` 驱动配置的 `tmpfs`，只适合演示，不适合保存重要代码。Docker Desktop 或 Docker VM 重启、卷卸载或环境清理后，文件可能丢失。

PostgreSQL 挂载 `/var/lib/postgresql/data`，Redis 挂载 `/data`，两者使用普通 Docker `local` Volume。停止演示服务不会自动删除数据库卷，但重要数据仍需单独备份。

## 6. Docker 网络和端口

本项目为用户容器创建独立网络，名称通常为 `lab-<container-id>`。

```bash
docker network ls
docker network inspect <network>
```

端口映射示例：

```text
127.0.0.1:60789 -> 8080/tcp
```

表示容器内应用监听 `8080`，宿主机通过 `60789` 访问。

```bash
docker ps
docker port <container>
```

容器内应用应监听 `0.0.0.0`，例如：

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

## 7. 容器终端和 Docker Socket

从宿主机进入容器：

```bash
docker exec -it <container> /bin/sh
```

看到 `/ #` 表示当前位于容器 Shell，不是宿主机。普通用户容器不应拥有 Docker CLI 或 `/var/run/docker.sock`：

```bash
command -v docker || echo 'Docker unavailable'
test ! -e /var/run/docker.sock && echo 'Socket unavailable'
```

Docker Socket 权限很高，挂载它可能使容器获得宿主机 Docker 管理能力。

## 8. Context、资源和安全

查看 Docker Context：

```bash
docker context ls
docker context show
```

本机演示要求使用 Docker Desktop 的本机 Unix Socket，不连接远程 Docker。

用户容器会设置 CPU、内存、Swap、进程数、磁盘参数和 `/tmp` 大小限制：

```bash
docker stats
docker inspect <container>
nproc
free -m
cat /sys/fs/cgroup/cpu.max 2>/dev/null || true
cat /sys/fs/cgroup/memory.max 2>/dev/null || true
```

容器还使用非 root 用户、只读根文件系统、丢弃 Linux capabilities、`no-new-privileges`、独立网络和过期自动停止等安全设置。

## 9. 网关和访问应用

容器内应用监听内部端口后，Docker 会动态映射到宿主机端口，可直接访问 `http://127.0.0.1:<宿主机端口>`。

页面中的“访问应用”通常使用 `https://c-<container-id>.apps.example.test`，需要 Traefik/Nginx 网关和域名解析。本机演示默认不启动网关，因此该链接可能无法访问。

## 10. 常用排查和风险命令

```bash
docker ps
docker ps -a
docker images
docker volume ls
docker network ls
docker stats
docker inspect <container>
docker logs <container>
docker port <container>
docker system df -v
```

查看容器挂载：

```bash
docker inspect <container> --format '{{range .Mounts}}{{println .Type .Name .Source "->" .Destination}}{{end}}'
```

不要随意执行 `docker volume prune` 或 `docker system prune`，它们可能删除未使用的卷、镜像、网络或容器。

## 11. 核心结论

1. 镜像是模板，容器是运行实例。
2. 删除容器不一定删除数据卷。
3. 本项目用户工作目录使用 `tmpfs`，不适合永久保存数据。
4. PostgreSQL 和 Redis 使用普通 Docker Volume 保存数据。
5. 容器端口必须通过端口映射访问。
6. 普通用户容器不能访问 Docker Socket。
7. “访问应用”依赖容器内部应用、端口映射和网关配置。
8. Docker Volume 不是备份，重要数据仍需单独备份。

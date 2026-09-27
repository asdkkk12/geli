# 实验室 Docker 容器平台

已接入 PostgreSQL、BullMQ/Redis、密码登录、真实 Docker Agent、WebSocket/xterm 终端及 Traefik 动态路由。实际部署说明见 [部署说明](docs/部署说明.md)。

本机演示：打开 Docker Desktop 后运行 `npm run demo`，然后访问 `http://127.0.0.1:5173`。首次默认账号为 `admin`，密码为 `yywzy26233a3`；已有账号不重置。停止使用 `npm run demo:stop`。详见 [本机演示启动](docs/本机演示启动.md)。

## 运行模型

用户提交申请 → 管理员审批 → PostgreSQL 事务写入创建任务 → BullMQ 执行 → Agent 创建容器 → 容器绑定申请人。

- Vue 3 + TypeScript：登录、申请、审批、容器、终端、日志、服务器、账号及审计页面。
- NestJS：服务端鉴权、数据库事务、任务恢复、资源预留、过期停止。
- PostgreSQL：用户、申请、容器、任务及审计；不再使用内存业务仓储。
- Redis：8 小时可撤销登录会话、30 秒一次性终端票据、BullMQ 队列。
- Agent：真实 Docker SDK；HMAC 签名、时间窗口和 nonce 防重放；生产强制 TLS。
- Traefik：通过受认证的 HTTP provider 每 5 秒获取路由，不挂 Docker Socket。

## 安装和验证

运行环境为 Node.js 22。仓库中的旧 `.env.example` 和旧开发 Compose 不是生产配置，不能用于上线；本轮没有修改已有凭据文件。

```bash
npm ci
npm run build
npm test
```

需要按部署说明配置环境后，分别启动：

```bash
node apps/api/dist/main.js
node apps/agent/dist/main.js
npm run dev:web
```

API、Agent 默认只监听回环地址。生产部署须配置各自服务环境和 TLS，不能直接把开发端口开放到校园网。

## 真正的终端与应用

终端固定以 UID/GID 1000 进入所属容器，Shell 输入通过浏览器 → API → Agent → Docker exec 传递。
容器使用只读根文件系统、可写个人数据卷、受限临时目录、CPU/内存/PID 限额、独立网络、删除全部 capabilities。

用户在 `/home/developer` 开发，使用 venv、npm 本地依赖等用户级安装。系统包由维护人员更新镜像，容器内不提供 sudo。应用应监听 `0.0.0.0` 和申请的端口。

删除容器会保留个人数据卷；清理数据由管理员另行确认。失败任务保留诊断状态，可通过管理员任务接口重试。没有静默回退到 mock 模式。

## 集成测试

`scripts/integration.cjs` 对本机 PostgreSQL、Redis 和 Docker 执行真实集成测试。默认 PostgreSQL 端口 55432、Redis 56379；支持 `TEST_DATABASE_URL`、`TEST_DOCKER_SOCKET`。需要预置 busybox 镜像。测试专用 tmpfs 卷不代表生产持久化存储。

```bash
node scripts/integration.cjs
TEST_GATEWAY=1 node scripts/integration.cjs
```

第二种测试还需要 `traefik:v3.6` 镜像和 Docker Desktop 的 `host.docker.internal`。只在该测试探针中允许 Traefik 自动生成的测试证书，不关闭生产 TLS 校验。

测试后保留容器、卷和数据库用于检查，不自动删除。脚本会停止自己启动的 API、Agent、Traefik 和用户测试容器。

## 部署前提

代码接入不等于学校环境已部署。真实两台服务器还需管理员提供：管理网络连通性、每节点签名密钥及 TLS 证书、审核后的镜像、支持硬容量配额的持久化卷驱动、校园网访问策略、泛域名 DNS 和网关证书。没有配额驱动时审批失败，不将申请容量冒充实际磁盘限制。

Docker 容器共享内核；禁止宿主机接口及配置加固不等于绝对防逃逸。Agent 持有 Docker 控制权限，属于高权限服务，需要管理员维护和系统更新。

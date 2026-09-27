# Web 容器申请审批与自动分配平台实施方案

## Summary

采用方案一：`Vue 3 + Node.js 管理平台 + 两台服务器受限 Agent + Docker Engine`。

用户通过 Web 页面提交容器申请；管理员审批后，平台根据资源和安全策略调用目标服务器 Agent 创建容器，并将容器绑定给申请用户。用户随后通过 Web Terminal 进入自己的容器，在容器内自由开发、安装依赖和部署应用。平台统一处理端口、域名、反向代理、资源限制和审计。

默认技术选择：

- 前端：Vue 3 + TypeScript + Vite + Element Plus
- 后端：Node.js + NestJS + TypeScript
- 数据库：PostgreSQL
- 缓存和任务队列：Redis
- 服务器 Agent：Node.js/TypeScript 独立服务
- 反向代理：Traefik 或 Nginx
- 容器终端：WebSocket + Agent 转发到指定容器的受控 Shell
- 部署方式：管理平台、数据库和 Redis 独立部署；两台服务器分别部署 Agent

## 总体架构

```text
用户浏览器
    |
    | HTTPS
    v
Vue Web 前端
    |
    | REST API / WebSocket
    v
Node.js 管理后端
    |
    +--> PostgreSQL
    |      用户、角色、申请、审批、容器、入口、配额、审计
    |
    +--> Redis
    |      异步任务、Agent 心跳、终端会话、状态缓存
    |
    +--> 服务器 Agent A
    |        |
    |        +--> Docker Engine A
    |        +--> 容器 A/B/C
    |
    +--> 服务器 Agent B
             |
             +--> Docker Engine B
             +--> 容器 D/E/F

统一网关 Traefik/Nginx
    |
    +--> 用户应用域名
    +--> Web Terminal WebSocket
```

### 组件职责

- Vue 前端：用户申请、审批、容器列表、终端、日志、应用入口和资源展示。
- Node.js 后端：认证、RBAC、审批、资源校验、容器归属、任务调度、审计和 Agent 通信。
- PostgreSQL：保存业务数据和审计记录。
- Redis：保存短期状态、异步任务和 Agent 心跳，不作为业务数据最终存储。
- Agent：只在本机执行白名单 Docker 操作，不提供宿主机 Shell。
- Docker Engine：运行受控容器。
- Traefik/Nginx：统一处理域名、HTTPS、反向代理和 WebSocket。
- Web Terminal：只连接到用户获批的目标容器，不连接宿主机。

## 核心业务流程

### 1. 用户申请容器

用户登录 Web 平台，填写：

- 容器名称；
- 使用目的；
- 镜像模板；
- CPU、内存、磁盘需求；
- 是否需要 GPU；
- 预计使用时长；
- 容器内应用端口；
- 数据持久化需求；
- 目标服务器偏好，可选。

后端执行基础校验：

- 用户账号有效；
- 用户没有超过容器数量配额；
- 申请资源不超过系统上限；
- 镜像属于审核通过的模板；
- 端口和域名申请符合规则；
- 不允许提交特权模式、Docker Socket、宿主机挂载等配置。

申请状态变为 `PENDING_APPROVAL`。

### 2. 管理员审批

审批人查看申请详情：

- 申请人和所属项目；
- 镜像模板；
- CPU、内存、GPU、磁盘和运行时长；
- 应用入口；
- 当前服务器资源；
- 历史使用情况。

审批结果：

- 通过：状态变为 `APPROVED`，进入创建任务；
- 驳回：状态变为 `REJECTED`，必须填写驳回原因；
- 退回修改：状态变为 `NEED_MODIFICATION`。

### 3. 系统创建并分配容器

后端选择服务器：

1. 过滤在线且 Docker 正常的服务器；
2. 检查服务器剩余 CPU、内存、磁盘和 GPU；
3. 检查用户和项目配额；
4. 按资源适配度选择服务器；
5. 创建异步容器任务；
6. 调用目标 Agent 创建容器；
7. Agent 返回容器 ID；
8. 后端保存容器归属关系；
9. 创建受控数据 Volume；
10. 创建应用入口和反向代理规则；
11. 执行健康检查；
12. 状态变为 `RUNNING` 或 `STOPPED`；
13. 通知用户容器已分配。

创建失败时：

- 任务进入 `FAILED`；
- 记录错误原因；
- 清理已创建的容器、Volume 和入口；
- 不产生半成品资源；
- 管理员可以重新执行任务。

### 4. 用户进入容器

用户点击“进入终端”：

1. 前端建立 WebSocket；
2. 后端校验登录身份；
3. 校验容器归属；
4. 校验容器状态；
5. 校验容器是否过期；
6. 后端向目标 Agent 发起受控终端请求；
7. Agent 在指定容器内执行非宿主机 Shell；
8. Agent 转发终端输入输出；
9. 全程记录进入时间、用户、容器和结束原因。

Agent 不接受用户传入的任意 Docker 参数，只允许使用后端签发的短期会话令牌和容器 ID。

## 核心接口设计

### 用户与申请

```text
POST   /api/auth/login
GET    /api/me
GET    /api/users/:id
POST   /api/container-applications
GET    /api/container-applications
GET    /api/container-applications/:id
POST   /api/container-applications/:id/submit
```

### 审批

```text
GET    /api/approvals
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/reject
POST   /api/approvals/:id/request-change
```

### 容器

```text
GET    /api/containers
GET    /api/containers/:id
POST   /api/containers/:id/start
POST   /api/containers/:id/stop
POST   /api/containers/:id/restart
DELETE /api/containers/:id
GET    /api/containers/:id/logs
POST   /api/containers/:id/terminal-session
```

所有容器接口都必须执行资源归属和角色校验。普通用户只能访问自己的容器，审批人只能访问授权项目，维护管理员可以查看全部容器。

### 应用入口

```text
POST   /api/containers/:id/ingresses
GET    /api/containers/:id/ingresses
PATCH  /api/ingresses/:id
DELETE /api/ingresses/:id
```

入口申请只允许填写：

- 容器内端口；
- 协议；
- 应用名称；
- 访问范围；
- 有效期。

用户不能填写宿主机端口，也不能直接提交 Nginx/Traefik 配置。

### Agent 内部接口

Agent 只允许管理平台后端调用，不允许普通用户直接访问：

```text
GET    /agent/health
GET    /agent/resources
POST   /agent/containers
POST   /agent/containers/:id/start
POST   /agent/containers/:id/stop
POST   /agent/containers/:id/restart
DELETE /agent/containers/:id
GET    /agent/containers/:id/logs
POST   /agent/containers/:id/exec
POST   /agent/heartbeat
```

Agent 接口必须：

- 使用双向 TLS 或签名认证；
- 校验管理平台服务身份；
- 使用短期请求签名；
- 拒绝任意 Docker 参数；
- 拒绝宿主机 Shell；
- 拒绝 Docker Socket 转发；
- 只允许操作平台登记的容器；
- 记录执行结果和失败原因。

## 核心数据模型

### User

- `id`
- `username`
- `display_name`
- `role`
- `status`
- `project_id`
- `quota_id`
- `created_at`

### Server

- `id`
- `name`
- `address`
- `agent_status`
- `docker_status`
- `cpu_total`
- `memory_total`
- `disk_total`
- `gpu_total`
- `last_heartbeat_at`

服务器密码和密钥不存入普通业务表，应使用加密密钥或独立 Secret 管理。

### ContainerApplication

- `id`
- `user_id`
- `project_id`
- `image_template_id`
- `purpose`
- `cpu_limit`
- `memory_limit`
- `gpu_limit`
- `disk_limit`
- `runtime_deadline`
- `status`
- `approval_status`

### Container

- `id`
- `application_id`
- `server_id`
- `docker_container_id`
- `owner_user_id`
- `status`
- `internal_name`
- `created_at`
- `expires_at`

### Ingress

- `id`
- `container_id`
- `internal_port`
- `protocol`
- `hostname`
- `access_scope`
- `status`
- `expires_at`

### AuditLog

- `id`
- `actor_user_id`
- `action`
- `resource_type`
- `resource_id`
- `source_ip`
- `result`
- `detail`
- `created_at`

## 安全实现要求

容器创建时固定禁止：

- `privileged`；
- `hostNetwork`；
- `hostPID`；
- `hostIPC`；
- Docker Socket 挂载；
- 任意宿主机路径挂载；
- 任意宿主机端口映射；
- 未审批的 Linux capabilities；
- 任意 Docker 参数透传；
- 使用宿主机账号启动容器。

容器默认：

- 使用非 root 用户；
- 使用独立 PID、Network 和 Mount Namespace；
- 只挂载平台分配的 Volume；
- 使用固定资源上限；
- 使用审核通过的镜像；
- 使用短期终端会话；
- 终端会话结束后关闭对应 Agent 连接。

## 前端页面

首期页面包括：

- 登录页；
- 用户首页；
- 我的容器；
- 容器申请页；
- 申请详情页；
- Web Terminal；
- 容器日志页；
- 应用入口管理页；
- 审批列表；
- 服务器状态页；
- 容器和资源监控页；
- 镜像模板管理页；
- 用户和项目管理页；
- 审计日志页。

## 任务与状态管理

容器创建、删除、入口配置和服务器状态同步均采用异步任务。

任务状态：

```text
PENDING
  ↓
RUNNING
  ↓
SUCCEEDED / FAILED
```

容器状态：

```text
PENDING_APPROVAL
  ↓
APPROVED
  ↓
CREATING
  ↓
RUNNING
  ↓
STOPPED / EXPIRED / DELETING / FAILED
```

平台重启后应通过 Agent 重新同步服务器和容器状态，不能只依赖数据库中的旧状态。

## 测试计划

### 功能测试

- 用户提交容器申请；
- 审批人通过、驳回和退回申请；
- 审批通过后自动创建容器；
- 容器成功分配给申请用户；
- 用户启动、停止、重启和删除自己的容器；
- 用户查看日志；
- 用户通过 Web Terminal 进入自己的容器；
- 用户在容器内执行 `git clone`、`npm install`、`python app.py`；
- 用户申请并访问自己的应用域名。

### 权限测试

- 用户不能查看其他用户容器；
- 用户不能操作其他用户容器；
- 用户不能查看其他用户日志；
- 用户不能创建宿主机端口映射；
- 用户不能提交 Docker Socket、特权模式和宿主机目录挂载；
- 审批人不能执行宿主机维护操作；
- Agent 不接受普通用户直接请求；
- 普通用户无法访问宿主机 Shell。

### 安全测试

- 容器内无法访问 Docker Socket；
- 容器内无法读取宿主机敏感文件；
- `ps` 和 `top` 不能显示宿主机进程；
- 容器之间不能读取对方数据；
- WebSocket 终端只能连接授权容器；
- 终端会话过期后自动断开；
- 用户绕过前端直接调用 API 时仍然被后端拒绝；
- Agent 参数篡改、重放请求和伪造请求会被拒绝。

### 故障测试

- Agent 离线时不能创建新容器；
- 管理平台故障时已有容器继续运行；
- Docker 创建失败时自动清理残留资源；
- 反向代理配置失败时容器本身仍可保留并显示异常；
- 服务器资源不足时申请无法通过；
- 容器到期后自动停止并回收入口。

## 分阶段实施

### 第一阶段：基础平台

- 初始化 Vue + NestJS 项目；
- 完成登录、角色和基础用户管理；
- 完成 PostgreSQL 数据模型；
- 完成两台服务器 Agent 心跳；
- 完成服务器状态展示。

### 第二阶段：申请审批和容器创建

- 实现容器申请表单；
- 实现审批流程；
- 实现镜像模板；
- 实现资源配额；
- 实现 Agent 白名单接口；
- 实现容器自动创建、分配和状态同步。

### 第三阶段：Web Terminal 和应用入口

- 实现 WebSocket 终端；
- 实现容器日志；
- 实现 Traefik/Nginx 动态入口；
- 实现域名和 HTTPS；
- 实现入口审批、回收和健康检查。

### 第四阶段：安全审计和稳定性

- 完成审计日志；
- 完成权限绕过测试；
- 完成容器隔离测试；
- 完成 Agent 断线和任务失败处理；
- 完成备份、恢复和部署文档；
- 完成首期上线检查。

## 默认假设

- 前端采用 Vue 3 + TypeScript + Vite；
- 后端采用 Node.js + NestJS + TypeScript；
- 数据库采用 PostgreSQL；
- Redis 用于异步任务和短期状态；
- 用户通过 Web Terminal 进入容器，不开放宿主机 SSH；
- 首期使用审核过的镜像模板，不支持任意镜像和任意 Docker 参数；
- 首期暂不强制支持 GPU，但数据模型和 Agent 接口预留 GPU 字段；
- 两台服务器分别部署 Agent；
- 首期规模不超过 30 用户、20 个同时运行容器；
- 首期不实现跨服务器迁移；
- 首期仅开放 HTTP/HTTPS 应用入口；
- 管理平台故障不影响已有容器运行。

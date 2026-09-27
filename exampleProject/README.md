# exampleProject 登录示例

逐步人工演示请看 [利用 geli 部署项目演示步骤](利用geli部署项目演示步骤.md)。

Vue 3 + Express + TypeScript + 独立 PostgreSQL。账号与 geli 平台账号独立。
Node.js 22；Express 同时提供页面和 API，监听 0.0.0.0:8080。

## 1. 部署架构

浏览器 → geli 分配的宿主机端口 → 用户容器内 Express:8080 → 独立 PostgreSQL。

geli 负责申请、审批和创建应用容器。数据库和附加专用网络由本机管理员准备，
不是 geli 当前已有的多服务编排能力。用户容器内不运行 Docker，不挂载 Docker Socket。
数据库不发布宿主机端口，普通命名卷持久化；专用内部 bridge 只连接本示例应用和数据库。
学校环境需要另行审批网络策略；本文先用于本机。

## 2. 创建应用容器（浏览器）

在 geli 根目录运行 npm run demo，访问 http://127.0.0.1:5173。
普通用户申请 example-login，模板 lab-dev，1 CPU、1024 MB内存、2 GB磁盘、内部端口8080。
管理员审批后等待 RUNNING。在宿主机 docker ps 找出对应 lab-UUID 名称。
不要选择已有业务容器。如果目标8080已有测试服务，先在其终端 Ctrl+C 停止。

## 3. 准备数据库与代码（宿主机）

以下命令中尖括号部分需要替换。先在 geli 根目录：

~~~bash
export PATH="$PWD/node_modules/node/bin:$PATH"
node --version
cd exampleProject
npm ci
npm run build
npm run deploy -- lab-<UUID> --check
~~~

--check 只读检查。实际部署创建独立数据库凭据配置，按项目要求先确认再操作。
密码选用20～128位字母、数字、下划线或连字符，存入自己的密码管理器。
不要复用 geli 账号密码。

macOS 默认 zsh 隐藏输入：

~~~bash
read -s 'EXAMPLE_DB_PASSWORD?独立数据库密码：'
echo
export EXAMPLE_DB_PASSWORD
npm run deploy -- lab-<UUID>
unset EXAMPLE_DB_PASSWORD
~~~

脚本检查容器标签、只读根目录、非特权设置和8080端口，核验已有资源归属；
创建独立 PostgreSQL、普通命名卷、内部网络；复制代码到 /home/developer/exampleProject。
不复制本机 node_modules、dist、日志或凭据，文件归 UID/GID 1000。

数据库限制512 MB内存、1 CPU，此资源在 geli 用户容器预算之外。
脚本打印资源名及实际访问地址，不固定端口。
数据库密码在 Docker 环境中对宿主机管理员可见，但不会写入源码或打印。
重复部署使用原密码，不重置已有数据库；不自动删除任何资源。
目标目录归属不明、8080已占用、专用网络连接其他应用时，脚本会拒绝继续。

## 4. 安装运行（geli Web Terminal）

进入 example-login 容器终端：

~~~bash
cd /home/developer/exampleProject
npm ci
npm run build
export PUBLIC_ORIGIN='http://127.0.0.1:<实际映射端口>'
~~~

PUBLIC_ORIGIN 必须与浏览器地址一致，无尾部斜杠。
隐藏输入首次数据库密码：

~~~bash
printf '数据库密码：'
stty -echo
IFS= read -r EXAMPLE_DB_PASSWORD
stty echo
printf '\n'
export DATABASE_URL="postgresql://example_user:$EXAMPLE_DB_PASSWORD@example-db:5432/example_project"
unset EXAMPLE_DB_PASSWORD
npm run init-user
npm start
~~~

如果输入中断导致终端不回显，执行 stty echo。
初始化交互输入本示例用户名和密码：用户名3～80位字母/数字/下划线/连字符，
密码12～200字符。重复初始化同名账号不改变密码。
数据库刚启动时可能尚未就绪，稍后重试初始化即可。
保持应用运行，在浏览器访问宿主机脚本打印的地址。
不要使用 geli 的账号登录这个独立应用。

## 5. 后台运行、日志和停止

本次已部署的示例：浏览器访问 http://127.0.0.1:53750，用户名 demo。
随机登录密码和本例数据库密码保存在宿主机 .runtime/local-demo.json（权限0600，Git忽略）。
这份文件只用于本机验收，不要分享或提交；上述端口是本次运行值，重新创建容器后请重新查询。

如已完成第3、4节的复制和构建，也可以在宿主机执行：

~~~bash
node scripts/start-local-demo.cjs lab-<UUID>
node scripts/check-live.cjs
~~~

start-local-demo 会创建或复用随机 demo 登录凭据，验证同名账号密码一致后后台启动；
运行前确保8080空闲。它从已确认属于本例的数据库容器读取连接凭据，
保存到本机已忽略的 .runtime/local-demo.json，不修改 geli 凭据。
check-live 验证实际端口上的页面、静态资源、登录和退出，只操作本例 demo 会话。

先按 Ctrl+C 停止前台应用，保持环境变量已配置：

~~~bash
mkdir -p .runtime
nohup node dist/server/main.js > .runtime/app.log 2>&1 < /dev/null &
echo $! > .runtime/app.pid
tail -n 50 .runtime/app.log
~~~

停止前检查：

~~~bash
ps -p "$(cat .runtime/app.pid)" -o pid,args
~~~

确认是本应用 node dist/server/main.js 后：

~~~bash
kill -TERM "$(cat .runtime/app.pid)"
~~~

geli 的“日志”查看容器主进程日志，不会自动显示本例文件日志。
容器主进程是 sleep infinity，重启容器不会自动启动本例服务，需要手动重新启动。

## 6. 数据保留与重新部署

geli 本机工作盘为 tmpfs，停止/卸载后文件可能丢失；源码以宿主机 exampleProject 为准。
数据库使用独立普通 local 卷，停止/重启 PostgreSQL 保留账号和会话记录。
如果应用目录丢失，重新运行宿主机部署脚本，再安装、构建、设置环境、启动。
端口变化时更新 PUBLIC_ORIGIN，数据库密码保持原值。

宿主机查询数据库（替换为脚本输出的专用数据库容器名）：

~~~bash
docker exec -it <数据库容器名> psql -U example_user -d example_project
~~~

psql 内查询：

~~~sql
SELECT id, username FROM example_users;
SELECT count(*) FROM example_sessions WHERE expires_at > now();
\q
~~~

仅针对本例数据库验收持久化：

~~~bash
docker restart <数据库容器名>
~~~

等待就绪后，原账号仍可登录。停止 geli 不会自动停止独立数据库，
如需停止，在宿主机执行 docker stop <数据库容器名>。
命名卷不是备份；本文不执行删除数据或清理卷。

## 7. 测试

~~~bash
npm test
~~~

默认运行构建、密码、HTTP会话、来源校验和限流测试。
也可在宿主机运行独立 Docker 数据库测试（先构建）：

~~~bash
npm run build
node scripts/verify-postgres.cjs
~~~

此脚本创建带 example.test 标签的独立数据库、网络、数据卷及测试运行器，生成随机数据库密码；
配置测试凭据前需得到确认。默认运行器镜像 node:22-bookworm-slim，也可通过
EXAMPLE_TEST_IMAGE 指定已有 Node22 镜像。测试后停止容器，保留全部数据，不自动删除。

真实 PostgreSQL 用例只有设置 EXAMPLE_TEST_DATABASE_URL 才会运行。
该连接串必须指向独立测试库，不能使用 geli 业务数据库。
测试保留随机测试账号，不执行破坏性清理。

验收：

- 正确账号可登录，错误密码拒绝，未登录 /api/me 返回401。
- 刷新页面保留登录；退出后旧会话不可用；会话8小时过期。
- 密码加盐 scrypt；数据库仅存会话令牌摘要。
- Cookie HttpOnly、SameSite=Lax；HTTPS origin 时自动 Secure。
- 写接口校验 Origin；单IP连续10次失败后限流15分钟。
- 限流为单实例内存实现，重启后计数重置。
- /health 检查真实数据库，故障返回503，不向客户端暴露连接串。
- PostgreSQL 无宿主机映射端口；重启后账号仍在。

## 8. 故障排查

- 页面打不开：检查 docker port、应用日志、8080监听；本机没有 apps.example.test 网关。
- 来源不允许：PUBLIC_ORIGIN 与浏览器协议、地址、端口必须一致，localhost与127.0.0.1不同。
- 数据库认证失败：需要首次密码，重跑脚本不重置数据库。
- example-db 无法解析：检查应用和数据库是否都连接专用网络。
- npm 安装失败：检查容器网络和CA，不要关闭TLS验证。
- 停止后目录消失：重新部署代码，独立数据库卷仍保留。

学校正式部署还需HTTPS、数据库访问策略、凭据管理、持久化工作盘及进程托管。

本次测试结果见 [验证记录](验证记录.md)。

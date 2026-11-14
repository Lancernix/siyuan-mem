# 中心：跑在服务器上，和思源同一个 Docker 网络
#
# 依赖只有 AI SDK 那几个包（ai / @ai-sdk/* / zod），全是纯 JS、没有原生模块，
# 所以 arm64 / amd64 都能直接 build，不需要编译工具链。
FROM node:24-alpine

# 日志按本地日期分文件，容器默认 UTC 会让「今天」错 8 小时。
ENV TZ=Asia/Shanghai
WORKDIR /app

# 先只拷依赖清单：改代码不用重装依赖，改依赖才会重建这一层。
# pnpm 版本跟 package.json 的 packageManager 对齐，别让 corepack 自己猜。
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.9.0 \
 && pnpm install --frozen-lockfile --prod \
 && npm cache clean --force

COPY src ./src

# 镜像里不拷 scripts/：那是开发期的构建和冒烟脚本，运行时不碰。少一份代码就少
# 一份要跟着补丁的东西，也少一条从容器里往外跑的路径。

# 不以 root 运行：容器里任何一处被拿下，宿主上的 /data 连同思源 token 就全在手里了。
#
# 直接用官方镜像自带的 node 用户（uid/gid 都是 1000），跟宿主机上的数据目录属主
# 对齐，容器写的队列、日志、索引，宿主机上的用户都能直接读写。
# 别自己 adduser：1000 已经被 node 占了，`addgroup -g 1000` 会直接失败。

# 配置、队列、原文索引、锁、日志全在 ~/.siyuan-mem 下，挂卷出去。
# 容器重建不会丢队列——丢掉意味着那几场会话白推了。
ENV HOME=/data
VOLUME ["/data"]

USER node

ENTRYPOINT ["node", "/app/src/cli/cli.mjs"]
CMD ["serve"]

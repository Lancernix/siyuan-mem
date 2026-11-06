# 中心：跑在服务器上，和思源同一个 Docker 网络
#
# 依赖只有 AI SDK 那几个包（ai / @ai-sdk/* / zod），全是纯 JS、没有原生模块，
# 所以 arm64 / amd64 都能直接 build，不需要编译工具链。
FROM node:22-alpine

# 日志按本地日期分文件，容器默认 UTC 会让「今天」错 8 小时。
ENV TZ=Asia/Shanghai
WORKDIR /app

# 先只拷依赖清单：改代码不用重装依赖，改依赖才会重建这一层。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# 配置、队列、原文索引、锁、日志全在 ~/.siyuan-mem 下，挂卷出去。
# 容器重建不会丢队列——丢掉意味着那几场会话白推了。
ENV HOME=/data
VOLUME ["/data"]

ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["serve"]

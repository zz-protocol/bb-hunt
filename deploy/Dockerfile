# bb-hunt — 零依赖，仅需 Node 运行时
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data

COPY package.json ./
COPY config.json ./
COPY src ./src
COPY tools ./tools

RUN mkdir -p /app/data && chown -R node:node /app
USER node

# 5 分钟没写 state.json 视为异常（进程卡死）
HEALTHCHECK --interval=5m --timeout=20s --start-period=2m --retries=3 \
  CMD node -e "const fs=require('fs');const s=fs.statSync('/app/data/state.json');process.exit(Date.now()-s.mtimeMs<15*60*1000?0:1)"

CMD ["node", "src/monitor.mjs"]

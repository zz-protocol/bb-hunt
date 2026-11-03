#!/usr/bin/env bash
# bb-hunt 一键部署（Docker）。幂等：可重复执行。
#
#   bash install.sh                 # 构建 + 自检 + 启动
#   bash install.sh --doctor-only   # 只做环境/凭据自检
#   bash install.sh --no-start      # 构建 + 自检，不启动
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DOCTOR_ONLY=0
NO_START=0
for a in "$@"; do
  case "$a" in
    --doctor-only) DOCTOR_ONLY=1 ;;
    --no-start)    NO_START=1 ;;
    -h|--help)     sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[bb-hunt]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 依赖检查 ----------
command -v docker >/dev/null 2>&1 || die "未安装 docker"
docker info >/dev/null 2>&1 || die "docker 守护进程不可用（无权限启动？试试 sudo 或把用户加入 docker 组）"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "缺少 docker compose（装 docker-compose-plugin）"
fi
log "compose: $DC"

# ---------- 2. 数据目录 ----------
mkdir -p data
if [ ! -f data/credentials.json ]; then
  cp credentials.example.json data/credentials.json
  warn "已生成 data/credentials.json（还是占位值）——请填入 360 / 雷神的凭据"
fi
if [ ! -f data/config.local.json ]; then
  cp config.local.example.json data/config.local.json
  warn "已生成 data/config.local.json —— 请填入通知通道（钉钉/Telegram/企业微信）"
fi
chmod 600 data/credentials.json data/config.local.json 2>/dev/null || true

# ---------- 3. 构建 ----------
if [ "$DOCTOR_ONLY" -eq 0 ]; then
  log "构建镜像…"
  $DC -f deploy/docker-compose.yml build
fi

# ---------- 4. 自检 ----------
log "运行 doctor 自检…"
set +e
$DC -f deploy/docker-compose.yml run --rm --no-deps bb-hunt node src/monitor.mjs doctor
DOCTOR_RC=$?
set -e
[ $DOCTOR_RC -ne 0 ] && warn "doctor 有未通过项（上面 ❌ 行）；凭据缺失不影响其余平台运行"

# ---------- 5. 启动 ----------
if [ "$DOCTOR_ONLY" -eq 0 ] && [ "$NO_START" -eq 0 ]; then
  log "启动服务…"
  $DC -f deploy/docker-compose.yml up -d
  sleep 5
  $DC -f deploy/docker-compose.yml ps
  log "最近日志："
  $DC -f deploy/docker-compose.yml logs --tail=20 bb-hunt || true
  cat <<'EOF'

──────────── 下一步 ────────────
· 看状态:   docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs status
· 测通知:   docker compose -f deploy/docker-compose.yml exec bb-hunt node src/monitor.mjs notify-test
· 看日志:   docker compose -f deploy/docker-compose.yml logs -f bb-hunt
· 加/换凭据: 把 data/credentials.json 放好，然后热加载（不用重启）：
             docker compose -f deploy/docker-compose.yml kill -s HUP bb-hunt
EOF
fi

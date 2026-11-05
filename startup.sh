#!/bin/sh
set -eu
cd /workspace/sable

# Load persisted secrets for revive / new shells (never echo values)
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

node scripts/preview.mjs stop || true

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi

# Any OpenAI-compatible provider works: LLM_API_KEY (+ LLM_BASE_URL, LLM_MODELS,
# LLM_API_STYLE), XAI_API_KEY, OPENAI_API_KEY or DEEPSEEK_API_KEY.
if [ -z "${LLM_API_KEY:-}${XAI_API_KEY:-}${OPENAI_API_KEY:-}${DEEPSEEK_API_KEY:-}${GROK_PROXY_TOKEN:-}" ]; then
  echo "warning: no LLM key (LLM_API_KEY / XAI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY) — UI will start but chat/media return 503" >>/tmp/sable-startup.log
fi

npm run dev >>/tmp/sable-startup.log 2>&1 &

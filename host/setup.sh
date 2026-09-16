#!/usr/bin/env bash
# One-shot host setup for Local Voice: models + llama-server router as a systemd user unit.
# Idempotent: re-run any time. Arch Linux with pacman is automated; other distros get instructions.
set -euo pipefail

DIR="${LOCAL_VOICE_DIR:-$HOME/.bb/local-voice}"
UNIT_DIR="$HOME/.config/systemd/user"
HF="https://huggingface.co"
PORT="${LOCAL_VOICE_PORT:-8091}"
# Polisher tier: "heavy" = Gemma 4 26B-A4B (MoE, 4B active: as fast as E4B on CPU, far stronger,
# ~16 GB RAM, 14.5 GB download); "light" = Gemma 4 E4B (~5 GB RAM). Default: heavy when the box
# has 32 GB+ of RAM. Override with LOCAL_VOICE_TIER=light|heavy or --light/--heavy.
TIER="${LOCAL_VOICE_TIER:-auto}"
for arg in "$@"; do case "$arg" in --light) TIER=light ;; --heavy) TIER=heavy ;; esac; done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

ram_gb() {
  if [ -r /proc/meminfo ]; then awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo
  else sysctl -n hw.memsize 2>/dev/null | awk '{ printf "%d", $1 / 1073741824 }'; fi
}
if [ "$TIER" = auto ]; then
  if [ "$(ram_gb)" -ge 32 ]; then TIER=heavy; else TIER=light; fi
fi
say "polisher tier: $TIER ($(ram_gb) GB RAM)"

# 1. binaries
if ! command -v llama-server >/dev/null 2>&1; then
  if command -v pacman >/dev/null 2>&1; then
    say "installing llama-cpp (and whisper-cpp for the fallback engine) with pacman"
    sudo pacman -S --needed --noconfirm llama-cpp whisper-cpp ffmpeg
  else
    cat <<'MSG'
llama-server is not on PATH. Install llama.cpp for your platform first:
  macOS:   brew install llama.cpp
  Debian:  build from https://github.com/ggml-org/llama.cpp (needs cmake) or use a release binary
Then re-run this script.
MSG
    exit 1
  fi
fi
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is required (browser clips are webm/opus)"; exit 1; }

# 2. models
mkdir -p "$DIR"
fetch() { # repo path-in-repo (stored under its basename)
  local name; name="$(basename "$2")"
  local file="$DIR/$name"
  [ -f "$file" ] && { say "have $name"; return; }
  say "downloading $name"
  curl -L --fail --progress-bar -o "$file.part" "$HF/$1/resolve/main/$2" && mv "$file.part" "$file"
}
fetch ggml-org/Qwen3-ASR-1.7B-GGUF Qwen3-ASR-1.7B-Q8_0.gguf
fetch ggml-org/Qwen3-ASR-1.7B-GGUF mmproj-Qwen3-ASR-1.7B-Q8_0.gguf
fetch ggml-org/Qwen3-ASR-0.6B-GGUF Qwen3-ASR-0.6B-Q8_0.gguf
fetch ggml-org/Qwen3-ASR-0.6B-GGUF mmproj-Qwen3-ASR-0.6B-Q8_0.gguf
fetch ggml-org/gemma-4-E4B-it-GGUF gemma-4-E4B-it-Q4_0.gguf
fetch ggml-org/gemma-4-E4B-it-GGUF mtp-gemma-4-E4B-it-Q4_0.gguf
fetch ggml-org/gemma-4-E2B-it-GGUF gemma-4-E2B-it-Q8_0.gguf
fetch ggml-org/gemma-4-E2B-it-GGUF mtp-gemma-4-E2B-it-Q8_0.gguf
if [ "$TIER" = heavy ]; then
  fetch unsloth/gemma-4-26B-A4B-it-qat-GGUF gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf
  fetch unsloth/gemma-4-26B-A4B-it-qat-GGUF MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf
fi
if [ ! -f "$DIR/Qwen3-ASR-1.7B-Q4_K_M.gguf" ]; then
  say "requantizing the ASR model to Q4_K_M (faster decode, same accuracy in our tests)"
  llama-quantize --allow-requantize "$DIR/Qwen3-ASR-1.7B-Q8_0.gguf" "$DIR/Qwen3-ASR-1.7B-Q4_K_M.gguf" Q4_K_M >/dev/null
fi

# 3. router preset + unit (templates live next to this script)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREADS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 8)"
if [ "$TIER" = heavy ]; then HEAVY_ON=true; LIGHT_ON=false; else HEAVY_ON=false; LIGHT_ON=true; fi
sed -e "s|__DIR__|$DIR|g" -e "s|__THREADS__|$THREADS|g" -e "s|__HEAVY_ON__|$HEAVY_ON|g" -e "s|__LIGHT_ON__|$LIGHT_ON|g" "$HERE/models.ini.template" > "$DIR/models.ini"
if [ "$TIER" = light ]; then
  # No 26B on disk: drop its section so the router does not try to load it on request.
  awk 'BEGIN{skip=0} /^\[/{skip=($0=="[gemma-4-26b]")} !skip' "$DIR/models.ini" > "$DIR/models.ini.tmp" && mv "$DIR/models.ini.tmp" "$DIR/models.ini"
fi
say "wrote $DIR/models.ini (threads=$THREADS, tier=$TIER)"

if command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  sed -e "s|__DIR__|$DIR|g" -e "s|__PORT__|$PORT|g" -e "s|__LLAMA__|$(command -v llama-server)|g" "$HERE/bb-local-voice.service.template" > "$UNIT_DIR/bb-local-voice.service"
  systemctl --user daemon-reload
  systemctl --user enable --now bb-local-voice.service
  systemctl --user restart bb-local-voice.service
  say "bb-local-voice.service enabled; waiting for the router"
  for _ in $(seq 1 90); do curl -s "http://127.0.0.1:$PORT/health" | grep -q ok && break; sleep 1; done
else
  say "no systemd: start the router yourself with:"
  echo "  llama-server --models-preset $DIR/models.ini --host 127.0.0.1 --port $PORT --models-max 3"
fi

curl -s "http://127.0.0.1:$PORT/v1/models" | python3 -c 'import sys,json; [print("  ", m["id"], m.get("status",{}).get("value", m.get("status"))) for m in json.load(sys.stdin)["data"]]' 2>/dev/null || true

if [ "$TIER" = heavy ] && command -v bb >/dev/null 2>&1; then
  say "pointing the plugin's polisher at gemma-4-26b (bb plugin config local-voice set polishModel gemma-4-26b)"
  bb plugin config local-voice set polishModel gemma-4-26b >/dev/null 2>&1 || echo "  (plugin not installed yet: set polishModel = gemma-4-26b in its settings after installing)"
fi
cat <<MSG

Done. Next:
  bb plugin install path:$(cd "$HERE/.." && pwd)      # or: bb plugin install local-voice@notpritam
  bb-app config set BB_TRANSCRIPTION local/qwen3-asr  # bb-app lives next to your bb-app install
  bb voice transcribe some-clip.wav                   # smoke test
MSG

# Local Voice — local speech-to-text for bb

Registers a `local` voice-transcription service for bb, served entirely on this
host: **Qwen3-ASR-1.7B** for recognition (any language, incl. Hindi and
Hinglish) and **Gemma 4 E2B** to turn non-English speech into English, both
kept warm by one `llama-server` router. whisper.cpp remains as a fallback
engine. A content script also docks a mic button to every text input in the bb
app (bb's own composer already has one; this covers the rest).

## Host setup (the machine running bb's primary host daemon)

```sh
sudo pacman -S llama-cpp whisper-cpp        # Arch; whisper-cpp only for the fallback
mkdir -p ~/.bb/local-voice && cd ~/.bb/local-voice
HF=https://huggingface.co
curl -L -O $HF/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf
curl -L -O $HF/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf
llama-quantize --allow-requantize Qwen3-ASR-1.7B-Q8_0.gguf Qwen3-ASR-1.7B-Q4_K_M.gguf Q4_K_M
curl -L -O $HF/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q8_0.gguf
```

`~/.bb/local-voice/models.ini` (router preset) and the user unit
`~/.config/systemd/user/bb-local-voice.service` are in [`host/`](host/). Then:

```sh
cp host/models.ini ~/.bb/local-voice/
cp host/bb-local-voice.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now bb-local-voice
curl -s http://127.0.0.1:8091/v1/models      # qwen3-asr + gemma-4-e2b loaded
```

## Install and switch bb to it

```sh
bb plugin install path:/home/pritam/personal/extensions/media/bb-plugin-local-voice
/home/pritam/bb-server/node_modules/.bin/bb-app config set BB_TRANSCRIPTION local/qwen3-asr --data-dir ~/.bb
bb voice transcribe clip.wav                  # smoke test through bb's own pipeline
```

Model segment → engine:

| `BB_TRANSCRIPTION` | engine |
|---|---|
| `local/qwen3-asr` | Qwen3-ASR-1.7B Q4_K_M on the router (default) |
| `local/qwen3-asr-0.6b` | smaller/faster Qwen3-ASR (loads on first use) |
| `local/whisper-small`, `local/whisper-medium` | whisper.cpp `~/.bb/whisper-models/ggml-<name>.bin` |

## How a clip is handled

1. ffmpeg → 16 kHz mono wav (the browser sends webm/opus).
2. Silence gate: below −50 dBFS returns `""` without touching a model (speech
   models hallucinate "you" / "Thank you." on silence).
3. `POST /v1/audio/transcriptions` on the router; llama.cpp returns
   `language <X><asr_text><text>` — the prefix gives the detected language.
4. If `translate` is on and the language is not English **and** at least 1.5 s
   of bb's 10 s budget remain: `POST /v1/chat/completions` to the translation
   model (thinking off, temperature 0). Any failure ships the raw transcript;
   translation never turns a good transcript into an error.

Measured on a 20-core Core Ultra 7 (no GPU): 8 s Hinglish clip ≈ 2.4 s ASR +
1.1 s translate; 11 s English ≈ 1.4 s; 34 s mixed ≈ 7.8 s ASR. Keep dictation
under ~30 s per clip to stay inside bb's 10 s per-attempt budget.

## Settings (`bb plugin config local-voice`)

| key | default | meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8091` | llama-server router |
| `translate` | `true` | English out for non-English speech |
| `translateModel` | `gemma-4-e2b` | router alias of the translator |
| `modelsDir` | `~/.bb/whisper-models` | whisper.cpp fallback models |
| `threads` | `12` | whisper-cli threads |

Settings are pushed to the host worker on load and on change (`config.json` in
the plugin's host data dir).

## Using the mic

- bb's composer mic works as before — it now runs locally.
- Every other `textarea`, text `input`, or `contenteditable` shows a round mic at
  its bottom-right while focused. Click to record, click again to transcribe and
  insert at the caret. **Ctrl+Shift+Space** toggles it from the keyboard.
- Needs HTTPS (omni.getbb.app is fine) and microphone permission in the browser.

## Development

```sh
/usr/bin/npm install
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
bb plugin dev
```

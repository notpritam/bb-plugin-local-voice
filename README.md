# Whisper — local voice for bb

Registers local **whisper.cpp** as bb's `whisper` voice-transcription service and docks a mic button to every text input in the bb app (bb's own composer already has one; this covers the rest). Speech in any language comes out as English by default.

## Host requirements (the machine running bb's primary host daemon)

```sh
sudo pacman -S whisper-cpp            # Arch: whisper-cli + whisper-server, pulls ffmpeg
mkdir -p ~/.bb/whisper-models
curl -L -o ~/.bb/whisper-models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

`whisper-cli` and `ffmpeg` must be on the daemon's `PATH`.

## Install and switch

```sh
bb plugin install path:/home/pritam/personal/extensions/media/bb-plugin-whisper
/home/pritam/bb-server/node_modules/.bin/bb-app config set BB_TRANSCRIPTION whisper/small --data-dir ~/.bb
bb voice transcribe clip.wav          # smoke test through bb's own pipeline
```

The `<model>` segment names `~/.bb/whisper-models/ggml-<model>.bin`. Any file from
https://huggingface.co/ggerganov/whisper.cpp works (`small`, `medium`, `small.en`, …).

## Timing budget

bb allows **10 s** per transcription attempt. On a 20-core CPU, `small` handles an
11 s clip in ~2.2 s and `medium` in ~6.5 s, so `small` is the default; use `medium`
only for short clips. `large-v3-turbo` is not trained for translation — skip it.

Silent clips (below −50 dBFS after conversion) return an empty transcript without
running whisper-cli, because Whisper hallucinates "you" / "Thank you." on silence.

## Settings (`bb plugin config whisper`)

| key | default | meaning |
|---|---|---|
| `modelsDir` | `~/.bb/whisper-models` | where `ggml-<model>.bin` files live |
| `threads` | `12` | `whisper-cli -t` |
| `translate` | `true` | `true` = English out; `false` = transcribe in the spoken language |

Settings are pushed to the host worker on load and on every change; the host keeps
them in its plugin data dir as `config.json`.

## Using the mic

- bb's composer mic works as before — it just runs locally now.
- Every other `textarea`, text `input`, or `contenteditable` shows a round mic at its
  bottom-right while focused. Click to record, click again to transcribe and insert
  at the caret. **Ctrl+Shift+Space** toggles the same thing from the keyboard.
- Needs HTTPS (omni.getbb.app is fine) and microphone permission in the browser.

## Development

```sh
/usr/bin/npm install
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
bb plugin dev        # rebuild + reload on save
```

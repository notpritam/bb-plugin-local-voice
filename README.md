# Local Voice — local dictation for bb, with insights and a leaderboard

**Product page and live leaderboard:** [voice.notpritam.in](https://voice.notpritam.in) · **Portfolio:** [notpritam.in/plugins/local-voice](https://notpritam.in/plugins/local-voice) · **Marketplace:** `local-voice@notpritam`

Speak into any text box in [bb](https://getbb.app) and get clean, written text back — recognised and polished entirely on your own machine, in any language, out as English.

- **Recognition:** Qwen3-ASR-1.7B (Alibaba, Apache-2.0) via `llama-server`. Hindi, Hinglish, English and 50+ languages; character-perfect on code-switched speech where Whisper stumbles.
- **Polish:** Gemma 4 E4B rewrites the dictation like a transcriptionist — fillers and false starts out, punctuation, numbers, lists, spelled-out file extensions (`dot t s x` → `.tsx`), identifiers kept — and renders non-English speech in English (switchable).
- **Everywhere:** bb's composer mic just works; a small round mic docks to every other text field (Ctrl+Shift+Space).
- **Insights:** words dictated, WPM, fixes made, categories, streak heatmap, an LLM-written *voice profile*, and a public **leaderboard**.
- **Private:** audio and text never leave your host. The leaderboard only ever receives `{ day, words, clips }` and a display name.

Measured on a 20-core CPU with no GPU: an 8 s Hinglish clip returns polished English in ~3.3 s; English in ~2.5 s.

## Install (10 minutes, ~5 GB of models)

On the machine that runs your bb primary host daemon:

```sh
git clone https://github.com/notpritam/bb-plugin-local-voice.git
cd bb-plugin-local-voice && npm install
./host/setup.sh                                   # installs llama.cpp, downloads models, starts the router (systemd user unit)
bb plugin install .                               # or: bb marketplace add git:github.com/notpritam/bb-marketplace@main && bb plugin install local-voice@notpritam
bb-app config set BB_TRANSCRIPTION local/qwen3-asr
bb voice transcribe some-clip.wav                 # smoke test
```

`setup.sh` is idempotent. Arch Linux is automated (`pacman`); on other systems install `llama.cpp` and `ffmpeg` first and re-run. It needs about 5 GB in `~/.bb/local-voice`.

Then hard-refresh the bb app: the **Voice** page appears in the sidebar and a mic appears on every text field.

## Using it

- **Composer:** click bb's mic, speak, click again. The result is inserted at the cursor.
- **Any other field:** focus it, press **Ctrl+Shift+Space** (or click the round mic at its corner), speak, press again. Dictation appends after the caret and never types over a selection.
- **Silence** produces nothing (no hallucinated "you").
- Keep a single take under ~30 s: bb allows 10 s per transcription attempt.

## Engines (`BB_TRANSCRIPTION`)

| value | engine |
|---|---|
| `local/qwen3-asr` | Qwen3-ASR-1.7B Q4_K_M on the router (default) |
| `local/qwen3-asr-0.6b` | smaller/faster ASR (loads on first use) |
| `local/whisper-small`, `local/whisper-medium` | whisper.cpp fallback (`~/.bb/whisper-models/ggml-<name>.bin`) |

## Settings (`bb plugin config local-voice`)

| key | default | meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8091` | llama-server router |
| `polish` | `true` | run the polisher on every clip |
| `translate` | `true` | polisher outputs English (off = keep the spoken language) |
| `polishModel` | `gemma-4-e4b` | router alias of the polisher (`gemma-4-e2b` is faster) |
| `leaderboard` | `false` | join the public leaderboard |
| `displayName` | — | name shown on the leaderboard |
| `leaderboardUrl` | `https://voice.notpritam.in/…/leaderboard` | leaderboard host |
| `modelsDir`, `threads` | | whisper.cpp fallback |

## Insights (sidebar → Voice)

- **Your usage** — total words, month-over-month, WPM gauge, fixes made (edits, fillers removed, clips translated), what you dictate (AI prompts / notes / messages / code, labelled by the local model), where (composer / fields / CLI), languages, streaks and a 24-week heatmap, peak time.
- **Your voice** — after 200 words, and every 2,000 words after that, the local model writes a persona (title, description, catchphrase, peak-time blurb); most-used and most-corrected words are computed locally. *Regenerate* any time.
- **Leaderboard** — this week (ISO week, with rank deltas) or all time; podium, table, jump-to-me. Opt in with `leaderboard=true` + `displayName`, then **Join**. Every 15 minutes your install posts the last 8 days of daily totals. **Leave** deletes your rows on the host.

Everything is stored in the plugin's SQLite on your bb server; **Clear history** wipes clips and the profile.

## Hosting a leaderboard yourself

The plugin *is* the leaderboard server: routes under `/api/v1/plugins/local-voice/http/leaderboard/*` are registered with `auth: "none"`, so the bb server answers them without a session. Publish exactly that path with a reverse proxy — `host/Caddyfile.snippet` shows the Caddy block — and point other installs' `leaderboardUrl` at it. Joins are limited to 10/hour/IP, reports to 60/min/IP; daily counts are capped at 60,000 words.

## How a clip flows

ffmpeg → 16 kHz wav → silence gate (−50 dBFS) → `POST /v1/audio/transcriptions` (Qwen3-ASR, warm) → `POST /v1/chat/completions` (Gemma, MTP speculative decoding, thinking off) → text; the host emits a `clip` event that the server records for Insights. Polishing is skipped when fewer than 1.5 s of bb's budget remain and any polish failure returns the raw transcript.

## Landing site

`site/` is the static page served at https://voice.notpritam.in by the same Caddy block that publishes the leaderboard routes (`host/Caddyfile.snippet`). Deploy with `rsync -a --delete site/ /var/www/local-voice/`. It loads no third-party scripts or fonts and renders the live board from the same origin.

## Development

```sh
npm install
./node_modules/.bin/vitest run       # 140+ tests: engines, pipeline, dock, insights, leaderboard
./node_modules/.bin/tsc --noEmit
bb plugin dev                        # rebuild + reload on save
```

Design notes live in the author's extensions repo (`docs/superpowers/specs/2026-09-1{4,5}-*`).

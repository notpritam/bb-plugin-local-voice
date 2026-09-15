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
| `leaderboardInvite` | — | invite code from the host (required to join) |
| `leaderboardHost` | `false` | this install hosts a board: shows the admin panel |
| `leaderboardMaxMembers` | `100` | host: cap on members |
| `modelsDir`, `threads` | | whisper.cpp fallback |

## Insights (sidebar → Voice)

- **Your usage** — total words, month-over-month, WPM gauge, fixes made (edits, fillers removed, clips translated), what you dictate (AI prompts / notes / messages / code, labelled by the local model), where (composer / fields / CLI), languages, streaks and a 24-week heatmap, peak time.
- **Your voice** — after 200 words, and every 2,000 words after that, the local model writes a persona (title, description, catchphrase, peak-time blurb); most-used and most-corrected words are computed locally. *Regenerate* any time.
- **Leaderboard** — this week (ISO week, with rank deltas) or all time; podium, table, jump-to-me. It is **invite-only**: opt in with `leaderboard=true`, `displayName` and the `leaderboardInvite` code the host gave you, then **Join**. Every 15 minutes your install posts the last 8 days of daily totals. **Leave** deletes your rows on the host.

Everything is stored in the plugin's SQLite on your bb server; **Clear history** wipes clips and the profile.

## Hosting a leaderboard yourself

The plugin *is* the leaderboard server: routes under `/api/v1/plugins/local-voice/http/leaderboard/*` are registered with `auth: "none"`, so the bb server answers them without a session. Publish exactly that path with a reverse proxy — `host/Caddyfile.snippet` shows the Caddy block — and point other installs' `leaderboardUrl` at it.

Joining needs an invite code. Set `leaderboardHost=true` on the hosting install and manage it from the Leaderboard tab's admin panel or the CLI:

```sh
bb local-voice invite "Beta testers" --uses 10   # prints a code to hand out
bb local-voice invites                            # codes, uses, state
bb local-voice members                            # who joined, words, last seen
bb local-voice events --limit 50                  # joins, reports, leaves, rejected attempts
bb local-voice revoke <code> · bb local-voice remove <member-id>
```

Limits: joins 10/hour/IP, reports and board reads 60/min/IP, 60,000 words per member-day, `leaderboardMaxMembers` (default 100). Rejected joins are logged with the reason.

## How a clip flows

![One dictation, start to finish: record, convert, recognise, parse, polish, insert, record the clip, measure, insights.](site/assets/pipeline.gif)

*42-second walkthrough of one real Hinglish take. [MP4](https://voice.notpritam.in/assets/pipeline.mp4) · [source](video/pipeline-explainer) (a [HyperFrames](https://github.com/heygen-com/hyperframes) composition; `npm run render` there rebuilds it).*

1. **Record** — the browser captures Opus/webm (`bb-dock.webm` from a docked field, bb's own name from the composer) and posts it to `/api/v1/system/voice-transcription` on your bb host.
2. **Convert** — ffmpeg → 16 kHz mono PCM. The wav is read by walking its RIFF chunks (ffmpeg adds a `LIST` chunk, so a 44-byte header assumption would be wrong): duration = data bytes ÷ 32, loudness = RMS in dBFS. Below −50 dBFS the clip is silence and returns empty instead of a hallucinated "you".
3. **Recognise** — `POST /v1/audio/transcriptions` to Qwen3-ASR-1.7B (warm on the llama-server router). It answers in the spoken language with a prefix: `language Hindi<asr_text>यार कल का डिप्लॉय…`.
4. **Parse** — one regex, `/^\s*language\s+([A-Za-z_-]+)\s*<asr_text>/u`, splits that into `language` and `text`. No prefix means an unknown language and the whole string is the text.
5. **Polish** — `POST /v1/chat/completions` to Gemma 4 E4B with a transcriptionist prompt: temperature 0, thinking off, MTP speculative decoding; fillers and false starts out, punctuation and lists in, `dot t s x` → `.tsx`, identifiers kept, output in English (switchable). Skipped when fewer than 1.5 s of bb's 10 s budget remain; any failure returns the raw transcript.
6. **Insert** — bb (composer) or the dock (any field) puts the text at the caret, collapsing a selection to its end first and adding the space you would have typed.
7. **Record the clip** — the host emits a `clip` signal `{filename, language, durationMs, rawText, text, polished, translated, asrMs, polishMs, engine, model}`; the server derives the surface from the filename (`bb-dock.*` → field, `recording.*` → composer, else CLI) and writes a row to its SQLite.
8. **Measure** — a Unicode tokenizer (letters, digits, marks; apostrophes kept) counts words; fillers (`um`, `uh`, `hmm`, …) are matched from a set; *fixes* is the token-level Levenshtein distance between raw and polished — 0 when the clip was translated, because a rewrite is not a correction; WPM = spoken words ÷ duration.
9. **Insights** — categories are labelled by the local model once a minute, the persona is rewritten every 2,000 words, and every 15 minutes `{day, words, clips}` for the last 8 days goes to the leaderboard if you joined.

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

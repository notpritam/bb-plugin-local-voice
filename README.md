# Local Voice — local dictation for bb, with insights and a leaderboard

**Product page and live leaderboard:** [voice.notpritam.in](https://voice.notpritam.in) · **Portfolio:** [notpritam.in/plugins/local-voice](https://notpritam.in/plugins/local-voice) · **Marketplace:** `local-voice@notpritam`

Speak into any text box in [bb](https://getbb.app) and get clean, written text back — recognised and polished entirely on your own machine, in any language, out as English.

- **Recognition:** Qwen3-ASR-1.7B (Alibaba, Apache-2.0) via `llama-server`. Hindi, Hinglish, English and 50+ languages; character-perfect on code-switched speech where Whisper stumbles.
- **Polish:** Gemma 4 E4B rewrites the dictation like a transcriptionist — fillers and false starts out, punctuation, numbers, lists, spelled-out file extensions (`dot t s x` → `.tsx`), identifiers kept — and renders non-English speech in English (switchable).
- **Everywhere:** bb's composer mic just works; a small round mic docks to every other text field (Ctrl+Shift+Space).
- **Instant, any length:** audio streams to the host *while you talk* and is recognised in ~5 s chunks on four llama-server slots; when you stop, only the last chunk and one short polish remain. No timeout, no length limit.
- **Audio first:** every clip is kept from its first slice. A failed transcription shows in **History** with a Retry button; Play, Copy, Transcribe again and Delete are there too.
- **Insights:** words dictated, WPM, fixes made, categories, streak heatmap, an LLM-written *voice profile*, and a public **leaderboard**.
- **Private:** audio and text never leave your host. The leaderboard only ever receives `{ day, words, clips }` and a display name.

Measured on a 20-core CPU with no GPU: the text lands ~2 s after you stop for a 9 s Hinglish take, and ~3 s for a 60 s one (the old whole-clip path took 15 s for the latter).

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

- **Composer:** click bb's mic, speak, click again. The result is inserted at the cursor. (bb's own transport has a 10 s cap and drops the audio on failure; the plugin quietly reroutes the composer's clip through its own streaming path, so neither applies.)
- **Any other field:** focus it, press **Ctrl+Shift+Space** (or click the round mic at its corner), speak, press again. Dictation appends after the caret and never types over a selection.
- **Silence** produces nothing (no hallucinated "you").
- **Failed?** The dock turns into a red ↻: click it (or press Ctrl+Shift+Space again) to retry on the spot. The clip is also in the Voice panel's **History** tab with its audio and a **Retry** button. Talk as long as you like.

## Engines (`BB_TRANSCRIPTION`)

| value | engine |
|---|---|
| `local/qwen3-asr` | Qwen3-ASR-1.7B Q4_K_M on the router (default) |
| `local/qwen3-asr-0.6b` | smaller/faster ASR (loads on first use) |
| `local/whisper-small`, `local/whisper-medium` | whisper.cpp fallback (`~/.bb/whisper-models/ggml-<name>.bin`) |

`BB_TRANSCRIPTION` only matters for `bb voice transcribe` and for other plugins that call bb's voice service; the mic dock and the composer use the plugin's own path, whose recogniser is the `asrModel` setting.

## Settings (`bb plugin config local-voice`)

| key | default | meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8091` | llama-server router |
| `polish` | `true` | run the polisher on every clip |
| `translate` | `true` | polisher outputs English (off = keep the spoken language) |
| `polishModel` | `gemma-4-e4b` | router alias of the polisher (`gemma-4-e2b` is smaller, not faster) |
| `asrModel` | `qwen3-asr` | recogniser for the mic dock, the composer and retries (`qwen3-asr-0.6b` is 2× faster, weaker on Hinglish) |
| `audioRetentionDays` | `30` | keep the audio of finished clips this long (`0` = forever); failed clips keep theirs until retried or deleted |
| `leaderboard` | `false` | join the public leaderboard |
| `displayName` | — | name shown on the leaderboard |
| `leaderboardUrl` | `https://voice.notpritam.in/…/leaderboard` | leaderboard host |
| `leaderboardInvite` | — | invite code from the host (required to join) |
| `leaderboardHost` | `false` | this install hosts a board: shows the admin panel |
| `leaderboardMaxMembers` | `100` | host: cap on members |
| `modelsDir`, `threads` | | whisper.cpp fallback |

## The Voice panel (sidebar → Voice)

- **History** — every clip, newest first, grouped by day, with its status. Play the audio, copy the text, transcribe again, delete; failed clips show why and a **Retry**. Search filters by text. Clips still recording or transcribing show a spinner and update live.
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

The browser hands the plugin a slice of audio every second. The host decodes what has arrived so far (ffmpeg copes with a truncated container), and every ~5 s of speech is cut **at a pause** and sent to Qwen3-ASR on one of four parallel slots — all while you are still talking. Runs of chunks that end at a long pause (≥ 450 ms, a finished thought) are polished as soon as they are recognised. When you stop, only the tail chunk and the last group's polish remain, so the wait is ~2 s whether the take was 8 s or 80 s. Every slice is written to SQLite as it arrives; a failed transcription keeps the audio and the row, and Retry sends the same audio down the same path.

![One dictation, start to finish: record, convert, recognise, parse, polish, insert, record the clip, measure, insights.](site/assets/pipeline.gif)

*42-second walkthrough of one real Hinglish take. [MP4](https://voice.notpritam.in/assets/pipeline.mp4) · [source](video/pipeline-explainer) (a [HyperFrames](https://github.com/heygen-com/hyperframes) composition; `npm run render` there rebuilds it).*

1. **Record** — MediaRecorder (Opus/webm) with a 1 s timeslice; each slice goes to the plugin's `rec_append` RPC and into SQLite. The dock does this itself; for bb's composer a content script wraps `MediaRecorder` and `fetch` so bb's own recorder streams the same way and bb's `POST /api/v1/system/voice-transcription` resolves through the plugin instead.
2. **Convert** — the host feeds everything received so far to `ffmpeg -i pipe:0 → s16le 16 kHz mono` (at most every 2 s; a truncated webm decodes to a byte-identical PCM prefix). Chunks are cut at the quietest 150 ms window once 5 s of speech is waiting, never later than 12 s; a chunk below −50 dBFS RMS is silence and skips the model.
3. **Recognise** — each chunk is a wav to `POST /v1/audio/transcriptions` on Qwen3-ASR-1.7B, up to four in flight (`np = 4` in `models.ini`). It answers in the spoken language with a prefix: `language Hindi<asr_text>यार कल का डिप्लॉय…`.
4. **Parse** — one regex, `/^\s*language\s+([A-Za-z_-]+)\s*<asr_text>/u`, splits that into `language` and `text`. No prefix means an unknown language and the whole string is the text. The clip's language is the majority vote across chunks.
5. **Polish** — a group of chunks ending at a long pause goes to `POST /v1/chat/completions` on Gemma 4 E4B with a transcriptionist prompt: temperature 0, thinking off, MTP speculative decoding; fillers and false starts out, punctuation and lists in, `dot t s x` → `.tsx`, identifiers kept, output in English (switchable). Any failure keeps that group's raw text. (`bb voice transcribe` still runs inside bb's 10 s budget: chunks in parallel, one polish at the end, skipped when under 1.5 s remains.)
6. **Insert** — bb (composer) or the dock (any field) puts the text at the caret, collapsing a selection to its end first and adding the space you would have typed.
7. **Record the clip** — the host emits a `rec` signal with the outcome; the server fills the row it opened at the first slice (`status` recording → transcribing → done | failed), keeps the audio, and answers the browser's long-poll.
8. **Measure** — a Unicode tokenizer (letters, digits, marks; apostrophes kept) counts words; fillers (`um`, `uh`, `hmm`, …) are matched from a set; *fixes* is the token-level Levenshtein distance between raw and polished — 0 when the clip was translated, because a rewrite is not a correction; WPM = spoken words ÷ duration.
9. **Insights** — categories are labelled by the local model once a minute, the persona is rewritten every 2,000 words, and every 15 minutes `{day, words, clips}` for the last 8 days goes to the leaderboard if you joined. Audio of finished clips is dropped after `audioRetentionDays`; rows stuck in progress for 10 minutes (a restart mid-clip) are marked failed, audio intact.

## Landing site

`site/` is the static page served at https://voice.notpritam.in by the same Caddy block that publishes the leaderboard routes (`host/Caddyfile.snippet`). Deploy with `rsync -a --delete site/ /var/www/local-voice/`. It loads no third-party scripts or fonts and renders the live board from the same origin.

## Development

```sh
npm install
./node_modules/.bin/vitest run       # 180+ tests: engines, chunking, sessions, bridge, dock, insights, leaderboard
./node_modules/.bin/tsc --noEmit
bb plugin dev                        # rebuild + reload on save
```

Design notes live in the author's extensions repo (`docs/superpowers/specs/2026-09-1{4,5}-*`).

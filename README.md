# Local Voice — dictation for bb, with insights and a leaderboard

**Product page and live leaderboard:** [voice.notpritam.in](https://voice.notpritam.in) · **Portfolio:** [notpritam.in/plugins/local-voice](https://notpritam.in/plugins/local-voice) · **Marketplace:** `local-voice@notpritam`

Speak into any text box in [bb](https://getbb.app) and get clean, written text back, in any language, out as English or as Hinglish in Latin letters.

- **Recognition:** [ElevenLabs Scribe v2](https://elevenlabs.io/docs/capabilities/speech-to-text) (batch), called from your bb host. Hindi, Hinglish, English and 90+ languages; fillers dropped (`no_verbatim`), your product names passed as keyterms. Hindi always comes back in Devanagari; the formatter fixes the script.
- **Formatting:** Claude (Haiku by default) through the Claude Agent SDK on the host's own Claude Code login (or bb's Account Pooler on that host) — no API key. It cleans the dictation like a transcriptionist: fillers and false starts out, punctuation, numbers, paragraphs and lists, spelled-out file extensions (`dot t s x` → `.tsx`), names kept; Hindi written in Latin letters, or the whole message in English (switchable). A warm Claude process is started when you start talking, so formatting takes ~1.2–1.6 s.
- **Everywhere:** bb's composer mic just works; a small round mic docks to every other text field (Ctrl+Shift+Space).
- **Instant, any length:** audio streams to the host *while you talk* and is recognised in ~5 s chunks, four in flight; when you stop, only the last chunk and one formatting pass remain. No timeout, no length limit.
- **Audio first:** every clip is kept from its first slice. A failed transcription shows in **History** with a Retry button; Play, Copy, Transcribe again and Delete are there too.
- **Insights:** words dictated, WPM, fixes made, categories, streak heatmap, an LLM-written *voice profile*, and a public **leaderboard**.
- **Where your words go:** audio goes to ElevenLabs, the transcript to Claude on your own login; clips, audio and insights stay in the plugin's SQLite on your bb server. The leaderboard only ever receives `{ day, words, clips }` and a display name.

Measured in the real bb app (composer mic, 1.3.0): the text lands 2.3–2.6 s after you stop for an 8 s take (English or Hinglish) and 2.7 s for a 20 s one; Scribe takes 0.6–1.1 s a chunk and the formatter 1.1–1.6 s. `bb voice transcribe` (whole clip, bb's 10 s budget) takes ~2.3–3 s for 4–20 s clips and ~6 s for a 72 s one.

1.3.0 replaced the local llama-server router (Qwen3-ASR + Gemma 4) with ElevenLabs Scribe + Claude; `host/setup.sh` and its systemd unit are gone.

## Install

On the machine that runs your bb primary host daemon (it needs `ffmpeg` and a signed-in Claude Code, `~/.local/bin/claude` or `claude` on PATH):

```sh
git clone https://github.com/notpritam/bb-plugin-local-voice.git
cd bb-plugin-local-voice && npm install
bb plugin install .                               # or: bb marketplace add git:github.com/notpritam/bb-marketplace@main && bb plugin install local-voice@notpritam
```

Then give it an ElevenLabs API key, one of:

- Settings → Installed plugins → Local Voice → **ElevenLabs API key** (a secret setting; the server hands it to the host, which keeps it in `~/.bb/plugins/local-voice/host-data/elevenlabs-api-key`, mode 600), or
- write that file yourself without the key touching your shell history: `install -m 600 /dev/stdin ~/.bb/plugins/local-voice/host-data/elevenlabs-api-key < key.txt`, or
- `ELEVENLABS_API_KEY` in the host daemon's environment.

```sh
bb-app config set BB_TRANSCRIPTION local/scribe_v2   # old values such as local/qwen3-asr keep working
bb voice transcribe some-clip.wav                    # smoke test
```

Then hard-refresh the bb app: the **Voice** page appears in the sidebar and a mic appears on every text field.

## Using it

- **Composer:** click bb's mic, speak, click again. The result is inserted at the cursor. (bb's own transport has a 10 s cap and drops the audio on failure; the plugin quietly reroutes the composer's clip through its own streaming path, so neither applies.)
- **Any other field:** focus it, press **Ctrl+Shift+Space** (or click the round mic at its corner), speak, press again. Dictation appends after the caret and never types over a selection.
- **Silence** produces nothing (no hallucinated "you").
- **Failed?** The dock turns into a red ↻: click it (or press Ctrl+Shift+Space again) to retry on the spot. The clip is also in the Voice panel's **History** tab with its audio and a **Retry** button. Talk as long as you like.

## Engines (`BB_TRANSCRIPTION`)

| value | engine |
|---|---|
| `local/scribe_v2` | ElevenLabs Scribe v2 + Claude formatting (default; any `local/scribe…` names that ElevenLabs model) |
| `local/qwen3-asr`, any other name | same as `local/<sttModel>` (old names keep working) |
| `local/whisper-small`, `local/whisper-medium` | whisper.cpp fallback (`~/.bb/whisper-models/ggml-<name>.bin`), no formatting |

`BB_TRANSCRIPTION` only matters for `bb voice transcribe` and for other plugins that call bb's voice service; the mic dock and the composer use the plugin's own path, whose model is the `sttModel` setting. Inside bb's 10 s budget the formatter is skipped when less than 1.5 s is left.

## Settings (`bb plugin config local-voice`)

| key | default | meaning |
|---|---|---|
| `elevenlabsApiKey` | — | ElevenLabs key (secret; see Install) |
| `polish` | `true` | format every clip with Claude (off = Scribe's text as is, Hindi stays in Devanagari) |
| `translate` | `true` | output English; off = keep the spoken language, Hindi in Latin letters (Hinglish) |
| `sttModel` | `scribe_v2` | ElevenLabs model for the mic dock, the composer and retries |
| `formatModel` | `haiku` | Claude model for formatting, categories and the voice profile |
| `audioRetentionDays` | `30` | keep the audio of finished clips this long (`0` = forever); failed clips keep theirs until retried or deleted |
| `leaderboard` | `false` | join the public leaderboard |
| `displayName` | — | name shown on the leaderboard |
| `leaderboardUrl` | `https://voice.notpritam.in/…/leaderboard` | leaderboard host |
| `leaderboardInvite` | — | invite code from the host (required to join) |
| `leaderboardHost` | `false` | this install hosts a board: shows the admin panel |
| `leaderboardMaxMembers` | `100` | host: cap on members |
| `modelsDir`, `threads` | | whisper.cpp fallback |

The router-era settings (`serverUrl`, `polishModel`, `asrModel`) are ignored if still saved.

**Claude's login:** the host runs Claude Code with thinking off, no tools, no settings or MCP servers, one turn, in a private empty directory. When bb's Account Pooler has a token for the primary host, Claude goes through the pooler (the same route bb's own Claude threads take there); otherwise it uses the host's own Claude Code login. Short English (four words or fewer) skips Claude; anything with Devanagari always goes through it. If Claude is slow (3 s + 10 ms a character), fails, or answers instead of cleaning up, Scribe's text is used.

## The Voice panel (sidebar → Voice)

- **History** — every clip, newest first, grouped by day, with its status. Play the audio, copy the text, transcribe again, delete; failed clips show why and a **Retry**. Search filters by text. Clips still recording or transcribing show a spinner and update live.
- **Your usage** — total words, month-over-month, WPM gauge, fixes made (edits, fillers removed, clips translated), what you dictate (AI prompts / notes / messages / code, labelled by Claude), where (composer / fields / CLI), languages, streaks and a 24-week heatmap, peak time.
- **Your voice** — after 200 words, and every 2,000 words after that, Claude writes a persona (title, description, catchphrase, peak-time blurb); most-used and most-corrected words are computed locally. *Regenerate* any time.
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

The browser hands the plugin a slice of audio every second. The host decodes what has arrived so far (ffmpeg copes with a truncated container), and every 4–6 s of speech is cut **at a pause** and sent to ElevenLabs Scribe, up to four requests in flight — all while you are still talking. When the recording starts, the host also starts a Claude Code process that waits for the text. When you stop, a long tail is split at pauses so its pieces run in parallel; the chunks' text is joined and formatted in one Claude pass (arranging a message needs all of it). Every slice is written to SQLite as it arrives; a failed transcription keeps the audio and the row, and Retry sends the same audio down the same path.

![One dictation, start to finish: record, convert, recognise, parse, polish, insert, record the clip, measure, insights.](site/assets/pipeline.gif)

*42-second walkthrough of one real Hinglish take. [MP4](https://voice.notpritam.in/assets/pipeline.mp4) · [source](video/pipeline-explainer) (a [HyperFrames](https://github.com/heygen-com/hyperframes) composition; `npm run render` there rebuilds it).*

1. **Record** — MediaRecorder (Opus/webm) with a 1 s timeslice; each slice goes to the plugin's `rec_append` RPC and into SQLite. The dock does this itself; for bb's composer a content script wraps `MediaRecorder` and `fetch` so bb's own recorder streams the same way and bb's `POST /api/v1/system/voice-transcription` resolves through the plugin instead.
2. **Convert** — the host feeds everything received so far to `ffmpeg -i pipe:0 → s16le 16 kHz mono` (at most every 2 s; a truncated webm decodes to a byte-identical PCM prefix). Chunks are cut at the earliest 150 ms pause after 4 s of speech once 6 s is waiting, never later than 12 s; a chunk below −50 dBFS RMS is silence and skips the model.
3. **Recognise** — each chunk's raw PCM goes to `POST https://api.elevenlabs.io/v1/speech-to-text` (`model_id=scribe_v2`, `file_format=pcm_s16le_16`, `no_verbatim=true`, `tag_audio_events=false`, `timestamps_granularity=none`, ~20 `keyterms` such as HQ, MCAVA, shadcn, FoundKeep), up to four in flight. Language is auto-detected (`eng`, `hin`, …); Hindi comes back in Devanagari, mixed with English words as spoken.
4. **Join** — chunk texts are joined in order; the clip's language is the majority across chunks. Errors map to bb's codes: a rejected key (401/403) or an outage (5xx, network) → `service_unavailable`, 429 → `rate_limited`.
5. **Format** — the joined text goes to the waiting Claude process (`<dictation>…</dictation>`): fillers and false starts out, punctuation and paragraphs, lists, `dot t s x` → `.tsx`, names kept, greetings kept, Hindi in Latin letters or English (switchable). Any failure, a timeout or an over-long answer keeps Scribe's text. A fresh spare process is started for the next dictation and dropped after 10 idle minutes.
6. **Insert** — bb (composer) or the dock (any field) puts the text at the caret, collapsing a selection to its end first and adding the space you would have typed.
7. **Record the clip** — the host emits a `rec` signal with the outcome; the server fills the row it opened at the first slice (`status` recording → transcribing → done | failed), keeps the audio, and answers the browser's long-poll.
8. **Measure** — a Unicode tokenizer (letters, digits, marks; apostrophes kept) counts words; fillers (`um`, `uh`, `hmm`, …) are matched from a set; *fixes* is the token-level Levenshtein distance between raw and polished — 0 when the clip was translated, because a rewrite is not a correction; WPM = spoken words ÷ duration.
9. **Insights** — categories are labelled by Claude once a minute (one call per batch of up to 20 clips), the persona is rewritten every 2,000 words, and every 15 minutes `{day, words, clips}` for the last 8 days goes to the leaderboard if you joined. Audio of finished clips is dropped after `audioRetentionDays`; rows stuck in progress for 10 minutes (a restart mid-clip) are marked failed, audio intact.

## Landing site

`site/` is the static page served at https://voice.notpritam.in by the same Caddy block that publishes the leaderboard routes (`host/Caddyfile.snippet`). Deploy with `rsync -a --delete site/ /var/www/local-voice/`. It loads no third-party scripts or fonts and renders the live board from the same origin.

## Development

```sh
npm install
./node_modules/.bin/vitest run       # 210+ tests: Scribe, formatter, chunking, sessions, bridge, dock, insights, leaderboard
./node_modules/.bin/tsc --noEmit
bb plugin dev                        # rebuild + reload on save
```

Design notes live in the author's extensions repo (`docs/superpowers/specs/2026-09-1{4,5}-*`).

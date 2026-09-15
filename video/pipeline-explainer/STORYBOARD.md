---
mode: autonomous
message: "A dictation is parsed step by step on your own machine — from a webm clip to a clean English sentence and a row of stats."
audience: developers who run bb and coding agents
duration: 42s
aspect: 1920x1080
---

# How a clip travels — station walk

One oversized canvas, nine stations in a row, one virtual camera. Blueprint: `spatial-pan-stations` (Hook variant: a rail of markers along the bottom, left-only pans). Rules: `viewport-change` (PAN), `multi-phase-camera` (stop sequencing), `discrete-text-sequence` (transcript typing, seek-safe proxy), `counting-dynamic-scale` (timers, count-ups), `stat-bars-and-fills` (level meter, gate bar, metric bars), `sine-wave-loop` (ambient meter breathing), `svg-path-draw` (rail line draws on).

## Frame 1
status: outline · src: index.html · 0.0–3.5s
Title station. Mark + "How a clip travels". Sub-line: "One dictation, start to finish, on your own machine." Rail draws on along the bottom with nine dots.

## Frame 2
status: outline · src: index.html · 3.5–8.0s
Record. REC dot, timer 00:00→00:07, live level meter; the raw Hinglish take types in word by word in mono. Caption: bb-dock.webm · Opus · 7.5 s.

## Frame 3
status: outline · src: index.html · 8.0–12.5s
Convert. ffmpeg → 16 kHz mono PCM. RIFF chunk walk (RIFF ▸ WAVE ▸ fmt ▸ LIST ▸ data) with data lit. Readouts: 7,536 ms · −18 dBFS; the gate at −50 dBFS with the level clearly above it: "speech, not silence".

## Frame 4
status: outline · src: index.html · 12.5–17.5s
Recognise. Qwen3-ASR 1.7B card; timer counts to 2.4 s; the raw model string appears: language Hindi<asr_text>यार कल का डिप्लॉय …

## Frame 5
status: outline · src: index.html · 17.5–21.5s
Parse. The regex `^language (\w+)<asr_text>` splits the string into two fields: language "Hindi" and text "यार कल का…".

## Frame 6
status: outline · src: index.html · 21.5–27.0s
Polish. Gemma 4 E4B card with its rules (fillers out, punctuation, identifiers kept, English out). Output fades up: "The deployment failed yesterday. Please fix the bug and send the pull request by this evening." 0.9 s.

## Frame 7
status: outline · src: index.html · 27.0–31.0s
Insert. A text field "Deploy notes|" — the sentence lands at the caret with the space you would have typed. "Never over a selection."

## Frame 8
status: outline · src: index.html · 31.0–37.0s
Record + measure. `clip` event → SQLite row. Metrics fill: 16 words · 17 spoken · 0 fillers · fixes 0 (translated) · Hindi · field · 7.5 s.

## Frame 9
status: outline · src: index.html · 37.0–42.0s
Insights + board. 155 WPM, 2-day streak, board row "1 · Pritam Sharma" in amber. Close: "Nothing left the box." + mark. Hold.

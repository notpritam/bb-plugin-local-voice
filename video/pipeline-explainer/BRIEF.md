---
workflow: general-video
flow: automation
storyboard: no
message: "A dictation is parsed step by step on your own machine — from a webm clip to a clean English sentence and a row of stats."
destination: web-embed
aspect: 1920x1080
language: en
audience: developers who run bb and coding agents
length: 40s
angle: how-to
---

## Intent

An explainer for the Local Voice landing page (voice.notpritam.in) and README that shows how one
dictation travels through the pipeline. Silent — it autoplays muted on a landing page — so every
step carries its own caption. Same design system as the landing page: cool fog and paper, ink
text, one REC-red accent, amber only for the leaderboard podium, Bricolage Grotesque for text and
JetBrains Mono for anything that is genuinely a transcript, a command, or data.

The running example is the real test clip:

- spoken: "yaar kal ka deploy fail ho gaya tha, bug fix karke aaj shaam tak pull request bhej do please"
- Qwen3-ASR returns: `language Hindi<asr_text>यार कल का डिप्लॉय फेल हो गया था, बग फिक्स करके आज शाम तक पुल रिक्वेस्ट भेजे डू प्लीज।`
- Gemma 4 polishes: "The deployment failed yesterday. Please fix the bug and send the pull request by this evening."

## Assets

- ../../site/assets/mark.svg — the plugin mark, used in the open and close.
- ../../site/assets/fonts/ — self-hosted Bricolage Grotesque + JetBrains Mono woff2 (no CDN fonts at render).

## Customizations

- Real numbers on screen: 7.5 s clip, −18 dBFS, 2.4 s recognition, 0.9 s polish, 16 words, 0 fillers, fixes 0 (translated).
- Close on the Insights/leaderboard beat: the clip becomes a row of stats and a spot on this week's board.

## Notes

- No narration, no music: the piece is a silent embed. Captions are the narration.
- One accent colour; no gradient washes, no card kit, no ALL-CAPS labels.
- Output: MP4 (H.264, 1920×1080) copied to site/assets/pipeline.mp4 and referenced from the README.

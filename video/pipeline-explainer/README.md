# Pipeline explainer

The 42-second animation on [voice.notpritam.in](https://voice.notpritam.in/#how) and in the repo README: one real Hinglish dictation walking through record → convert → recognise → parse → polish → insert → clip row → metrics → insights.

It is a [HyperFrames](https://github.com/heygen-com/hyperframes) composition (`index.html`, one paused GSAP timeline, a virtual camera panning across nine stations). `BRIEF.md` and `STORYBOARD.md` hold the plan.

```sh
npm run check                                   # lint + contrast + determinism
npx --yes hyperframes@0.8.40 snapshot --at 6.5,20,35
npm run render -- --quality delivery -o renders/pipeline.mp4
```

Then, from the repo root:

```sh
cp video/pipeline-explainer/renders/pipeline.mp4 site/assets/pipeline.mp4
ffmpeg -y -ss 2.5 -i site/assets/pipeline.mp4 -frames:v 1 -vf scale=1600:-1 -quality 82 site/assets/pipeline-poster.webp
ffmpeg -y -i site/assets/pipeline.mp4 -vf "fps=12,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 site/assets/pipeline.gif
```

Numbers and strings in the animation are real: the sample take, the `language Hindi<asr_text>` prefix, the parse regex, the −50 dBFS gate, the ASR/polish timings.

// Hero demo: a real take from the test suite, recognised then polished. One
// page-load sequence; reduced-motion users get the finished state at once.
(() => {
  const demo = document.querySelector(".demo");
  const raw = document.getElementById("demo-raw");
  const out = document.getElementById("demo-out");
  const time = document.getElementById("demo-time");
  const state = document.getElementById("demo-state");
  const bars = [...document.querySelectorAll(".meter i")];
  if (!demo || !raw || !out || !time || !state) return;

  const SPOKEN = "yaar kal ka deploy fail ho gaya tha, bug fix karke aaj shaam tak pull request bhej do please";
  const POLISHED = "The deployment failed yesterday. Please fix the bug and send the pull request by this evening.";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const finish = () => {
    raw.textContent = SPOKEN;
    out.textContent = POLISHED;
    time.textContent = "00:08";
    state.textContent = "Polished in 3.3 s";
    demo.dataset.phase = "done";
  };
  if (reduced) return finish();

  const words = SPOKEN.split(" ");
  let i = 0;
  let ms = 0;
  demo.dataset.phase = "recording";
  const meterTimer = setInterval(() => {
    for (const bar of bars) bar.style.height = `${15 + Math.random() * 85}%`;
  }, 90);
  const clock = setInterval(() => {
    ms += 100;
    time.textContent = `00:${String(Math.min(8, Math.floor(ms / 1000))).padStart(2, "0")}`;
  }, 100);
  const typer = setInterval(() => {
    raw.textContent = words.slice(0, i + 1).join(" ");
    i += 1;
    if (i >= words.length) {
      clearInterval(typer);
      clearInterval(meterTimer);
      clearInterval(clock);
      demo.dataset.phase = "polishing";
      state.textContent = "Polishing";
      setTimeout(() => {
        out.textContent = POLISHED;
        state.textContent = "Polished in 3.3 s";
        demo.dataset.phase = "done";
      }, 1300);
    }
  }, 420);
})();

// Live leaderboard: same origin, so the API is /api/... on voice.notpritam.in.
(async () => {
  const board = document.getElementById("board");
  const meta = document.getElementById("board-meta");
  if (!board) return;
  const fmt = new Intl.NumberFormat("en-US");
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  try {
    const res = await fetch("/api/v1/plugins/local-voice/http/leaderboard/board?period=week&limit=25");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.members || data.members.length === 0) {
      board.innerHTML = '<p class="muted">Nobody has dictated this week yet. Install the plugin, opt in, and be first.</p>';
      return;
    }
    if (meta) meta.textContent = `${data.total} ${data.total === 1 ? "person" : "people"} on the board this week.`;
    const rows = data.members
      .map((m) => {
        const delta = m.delta === null || m.delta === 0 ? "" : m.delta > 0 ? `<span class="up">↑${m.delta}</span>` : `<span class="down">↓${Math.abs(m.delta)}</span>`;
        return `<tr class="${m.rank === 1 ? "first" : ""}"><td><span class="rank">${m.rank}</span>${delta}</td><td>${esc(m.displayName)}</td><td class="right">${fmt.format(m.words)}</td></tr>`;
      })
      .join("");
    board.innerHTML = `<table><thead><tr><th>Rank</th><th>Member</th><th class="right">Words this week</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (error) {
    board.innerHTML = `<p class="muted">The board is not reachable right now (${esc(String(error.message || error))}). It lives on the same host as this page; try again in a moment.</p>`;
  }
})();

// The pipeline film: honour reduced motion by not auto-playing (the poster
// and the controls stay), and stop looping once the tab is hidden.
(() => {
  const film = document.querySelector(".film video");
  if (!film) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    film.removeAttribute("autoplay");
    film.pause();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) film.pause();
    else if (film.hasAttribute("autoplay")) film.play().catch(() => {});
  });
})();

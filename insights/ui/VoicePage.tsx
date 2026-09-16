import { useState } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { insightsRpcContract } from "../rpc";
import { HistoryTab } from "./HistoryTab";
import { UsageTab } from "./UsageTab";
import { LeaderboardTab } from "./LeaderboardTab";
import { VoiceTab } from "./VoiceTab";

const TABS = ["History", "Your usage", "Your voice", "Leaderboard"] as const;

export function VoicePage(_props: PluginNavPanelProps) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("History");
  const rpc = useRpc<typeof insightsRpcContract>();
  return (
    <div className="bbv-page">
      <header className="bbv-header">
        <div>
          <h1>Voice</h1>
          <p className="bbv-header-copy">Everything you dictate through Local Voice — every clip with its audio, counted and read back to you. Nothing here leaves this machine.</p>
        </div>
        <button
          type="button"
          className="bbv-link"
          onClick={() => {
            if (confirm("Delete every recorded dictation, its audio, and the voice profile?")) void rpc.call("insights_clear", null);
          }}
        >
          Clear history
        </button>
      </header>
      <nav className="bbv-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" className={t === tab ? "bbv-tab bbv-tab-active" : "bbv-tab"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "History" ? <HistoryTab /> : tab === "Your usage" ? <UsageTab /> : tab === "Your voice" ? <VoiceTab /> : <LeaderboardTab />}
    </div>
  );
}

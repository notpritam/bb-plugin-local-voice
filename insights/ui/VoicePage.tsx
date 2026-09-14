import { useState } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { insightsRpcContract } from "../rpc";
import { UsageTab } from "./UsageTab";

const TABS = ["Your usage", "Your voice", "Leaderboard"] as const;

export function VoicePage(_props: PluginNavPanelProps) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Your usage");
  const rpc = useRpc<typeof insightsRpcContract>();
  return (
    <div className="bbv-page">
      <header className="bbv-header">
        <h1>Insights</h1>
        <button
          type="button"
          className="bbv-link"
          onClick={() => {
            if (confirm("Delete all recorded dictations and the voice profile?")) void rpc.call("insights_clear", null);
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
      {tab === "Your usage" ? <UsageTab /> : <p className="bbv-muted">Coming soon.</p>}
    </div>
  );
}

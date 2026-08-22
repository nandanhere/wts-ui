"use client";

import { Settings, Info, FileJson, Database, Shield } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/**
 * Settings panel — read-only placeholder. All configuration is local
 * and scope-limited to the dashboard environment.
 */
export function SettingsPanel() {
  return (
    <div className="animate-in">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold tracking-tight flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
          <Settings size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
          Settings
        </h2>
      </div>

      <div className="bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl p-6">
        <div className="flex items-start gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "rgba(96,165,250,0.12)", color: "var(--accent)" }}
          >
            <Info size={16} aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white/80 mb-1">Local Scope</h3>
            <p className="text-xs text-muted/60 leading-relaxed max-w-lg">
              Dashboard settings are read-only in this environment.
              Configuration for workspace scanning, snapshot retention, and
              Graphify paths is managed from the backend.
            </p>
          </div>
        </div>

        {/* Info cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
          {[
            {
              icon: FileJson,
              label: "Workspace Registry",
              desc: "Recent workspace paths stored at ~/.config/dashboard/workspace-registry.json",
            },
            {
              icon: Database,
              label: "Snapshot Storage",
              desc: "Snapshots persisted server-side in the configured database (read-only view)",
            },
            {
              icon: Shield,
              label: "Access Scope",
              desc: "All operations are local — no remote infrastructure management",
            },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-xl p-3.5 border"
              style={{
                background: "color-mix(in srgb, var(--color-background-surface) 60%, transparent)",
                borderColor: "var(--color-border)",
              }}
            >
              <item.icon size={16} className="text-accent/70 mb-2" aria-hidden="true" />
              <div className="text-xs font-semibold text-white/70 mb-1">{item.label}</div>
              <div className="text-[10px] text-muted/50 leading-relaxed">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

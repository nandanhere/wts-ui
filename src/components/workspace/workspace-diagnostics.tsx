"use client";

import type { WorkspaceDefinition } from "@/lib/workspace/types";
import { AlertTriangle, CheckCircle, Folder, FileJson } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface WorkspaceDiagnosticsProps {
  definition: WorkspaceDefinition;
  scanErrors: string[];
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function WorkspaceDiagnostics({
  definition,
  scanErrors,
}: WorkspaceDiagnosticsProps) {
  const totalFolders = definition.folders.length;
  const existsFolders = definition.folders.filter((f) => f.exists).length;
  const missingFolders = totalFolders - existsFolders;

  return (
    <div className="animate-in">
      {/* Workspace file info */}
      <div className="bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl p-3.5 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <FileJson size={13} className="text-accent shrink-0" aria-hidden="true" />
          <span className="text-xs font-semibold text-white/80 truncate">
            {definition.name}
          </span>
          <span className="text-[9px] text-muted/50 font-mono truncate ml-auto">
            {definition.folders.length} folder{definition.folders.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="text-[10px] text-muted/50 font-mono truncate">
          {definition.filePath}
        </div>
      </div>

      {/* Folder list */}
      <div className="bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl overflow-hidden divide-y divide-border/20">
        {definition.folders.map((folder) => (
          <FolderRow key={folder.resolvedPath} folder={folder} />
        ))}
      </div>

      {/* Folder summary */}
      <div className="flex items-center gap-3 mt-2 px-1">
        <span className="text-[9px] text-muted/40 font-mono">
          {existsFolders}/{totalFolders} folders exist on disk
        </span>
        {missingFolders > 0 && (
          <span className="text-[9px] text-warn/60 font-mono flex items-center gap-1">
            <AlertTriangle size={9} aria-hidden="true" />
            {missingFolders} missing
          </span>
        )}
        {missingFolders === 0 && totalFolders > 0 && (
          <span className="text-[9px] text-success/60 font-mono flex items-center gap-1">
            <CheckCircle size={9} aria-hidden="true" />
            All OK
          </span>
        )}
      </div>

      {/* Scan errors */}
      {scanErrors.length > 0 && (
        <div className="mt-3 bg-danger/10 border border-danger/20 rounded-xl p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={12} className="text-danger shrink-0" aria-hidden="true" />
            <span className="text-[10px] font-semibold text-danger/80 uppercase tracking-wider">
              Scan Errors
            </span>
          </div>
          <ul className="space-y-1">
            {scanErrors.map((err, i) => (
              <li
                key={i}
                className="text-[10px] text-danger/60 font-mono leading-relaxed"
              >
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Folder row sub-component                                           */
/* ------------------------------------------------------------------ */

function FolderRow({
  folder,
}: {
  folder: WorkspaceDefinition["folders"][number];
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <Folder
        size={13}
        className={
          folder.exists ? "text-accent/50 shrink-0" : "text-danger/40 shrink-0"
        }
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-white/70 truncate">
          {folder.name}
        </div>
        <div className="text-[9px] text-muted/50 font-mono truncate mt-px">
          {folder.resolvedPath}
        </div>
      </div>
      {folder.exists ? (
        <span
          className="text-[8px] text-success/60 font-semibold uppercase tracking-wider shrink-0"
          title="Exists on disk"
        >
          OK
        </span>
      ) : (
        <span
          className="text-[8px] text-danger/60 font-semibold uppercase tracking-wider shrink-0 flex items-center gap-1"
          title="Missing on disk"
        >
          <AlertTriangle size={9} aria-hidden="true" />
          MISSING
        </span>
      )}
    </div>
  );
}

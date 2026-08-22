/**
 * Config reader for .dash-tasks.yaml.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import type { DashTasksConfig } from "./types";

const CONFIG_FILENAME = ".dash-tasks.yaml";
const CONFIG_FILENAME_ALT = ".dash-tasks.yml";

export interface ConfigResult {
  config: DashTasksConfig | null;
  path: string | null;
  /** Error message if config file exists but parsing failed */
  error: string | null;
}

/**
 * Load and parse .dash-tasks.yaml from a repo root.
 * Returns null config if no file exists or parsing fails.
 */
export function loadConfig(repoPath: string): ConfigResult {
  const candidates = [
    join(/* turbopackIgnore: true */ repoPath, CONFIG_FILENAME),
    join(/* turbopackIgnore: true */ repoPath, CONFIG_FILENAME_ALT),
  ];

  for (const filePath of candidates) {
    if (!existsSync(/* turbopackIgnore: true */ filePath)) continue;

    try {
      const raw = readFileSync(/* turbopackIgnore: true */ filePath, "utf-8");
      const parsed = yaml.load(raw) as DashTasksConfig;

      if (!parsed || !Array.isArray(parsed.processes)) {
        return { config: null, path: filePath, error: "Missing processes array" };
      }

      return { config: parsed, path: filePath, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Parse error";
      return { config: null, path: filePath, error: msg };
    }
  }

  return { config: null, path: null, error: null };
}

/**
 * Generate a minimal config for a repo based on common conventions.
 * Used when no config exists and user wants a quick start.
 */
export function generateConfig(repoName: string): DashTasksConfig {
  return {
    processes: [
      {
        name: "dev",
        command: "echo 'Add your dev command here'",
        description: `Development server for ${repoName}`,
      },
    ],
  };
}

/**
 * Write a config file to disk.
 */
export function saveConfig(repoPath: string, config: DashTasksConfig): string {
  const filePath = join(
    /* turbopackIgnore: true */ repoPath,
    CONFIG_FILENAME,
  );
  const yamlStr = yaml.dump(config, { indent: 2, lineWidth: 120 });
  writeFileSync(/* turbopackIgnore: true */ filePath, yamlStr, "utf-8");
  return filePath;
}

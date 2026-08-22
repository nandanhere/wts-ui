import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(ts: string | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleDateString("en-CA");
}

export function timeAgo(ts: string | null): string {
  if (!ts) return "";
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (d === 0) return "(today)";
  if (d === 1) return "(1d)";
  if (d < 30) return `(${d}d)`;
  return "";
}

export function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

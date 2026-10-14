import { useEffect, useRef, useState } from "react";
import styles from "./LocalWorkspace.module.css";

export function RecoveryCopyButton({ label, text, disabled = false, children }: {
  label: string;
  text: string;
  disabled?: boolean;
  children?: string;
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setState("idle");
    return () => { generation.current += 1; };
  }, [text]);
  const copy = async () => {
    const request = ++generation.current;
    setState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (generation.current === request) setState("copied");
    } catch {
      if (generation.current === request) setState("error");
    }
  };
  return <span className={styles.recoveryCopy}>
    <button className={styles.secondaryButton} aria-label={label} disabled={disabled || state === "copying"} onClick={() => void copy()} type="button">{children ?? label}</button>
    {state === "copied" && <span role="status">Copied.</span>}
    {state === "error" && <span className={styles.recoveryCopyFallback}>
      <span role="alert">Clipboard access failed. Select and copy the text below.</span>
      <textarea autoFocus aria-label={`${label} manually`} readOnly value={text} onFocus={(event) => event.currentTarget.select()} rows={Math.min(5, text.split("\n").length)} />
    </span>}
  </span>;
}

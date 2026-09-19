import { type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import styles from "./LocalWorkspace.module.css";

export interface InfoTooltipProps {
  content?: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function InfoTooltip({
  content,
  children,
  side = "top",
  align = "center",
}: InfoTooltipProps) {
  if (!content) {
    return <>{children}</>;
  }

  return (
    <Tooltip.Provider
      delayDuration={0}
      skipDelayDuration={0}
      disableHoverableContent
    >
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className={styles.infoTooltipContent}
            side={side}
            align={align}
            sideOffset={4}
          >
            {content}
            <Tooltip.Arrow className={styles.infoTooltipArrow} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

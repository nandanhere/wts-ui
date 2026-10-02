import { memo, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Glyph, type GlyphName } from "./Glyph";
import styles from "./LocalWorkspace.module.css";

export interface CommandItem {
  id: string;
  label: string;
  description: string;
  group: string;
  icon: GlyphName;
  disabled?: boolean;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commandQuery: string;
  onCommandQueryChange: (query: string) => void;
  activeCommandIndex: number;
  onActiveCommandIndexChange: (index: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  matchingCommandItems: CommandItem[];
  commandGroups: string[];
}

export const CommandPalette = memo(function CommandPalette({
  open,
  onOpenChange,
  commandQuery,
  onCommandQueryChange,
  activeCommandIndex,
  onActiveCommandIndexChange,
  inputRef,
  returnFocusRef,
  matchingCommandItems,
  commandGroups,
}: CommandPaletteProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          onCommandQueryChange("");
          onActiveCommandIndexChange(0);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.commandOverlay} />
        <Dialog.Content
          aria-describedby="command-palette-description"
          className={`${styles.commandPalette} ${styles.portalSurface}`}
          data-ui="commands.palette"
          data-ui-label="Command palette"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const returnTarget = returnFocusRef?.current;
            if (!returnTarget?.isConnected) return;
            event.preventDefault();
            returnTarget.focus();
          }}
        >
          <Dialog.Title className={styles.commandPaletteTitle}>
            Commands
          </Dialog.Title>
          <Dialog.Description
            className={styles.commandPaletteTitle}
            id="command-palette-description"
          >
            Search navigation and actions in WTS.
          </Dialog.Description>
          <div
            className={styles.commandSearch}
            data-ui="commands.search"
            data-ui-label="Command search"
          >
            <Glyph name="search" size={19} />
            <input
              ref={inputRef}
              aria-activedescendant={
                matchingCommandItems.length
                  ? `command-${matchingCommandItems[activeCommandIndex]!.id}`
                  : undefined
              }
              aria-controls="command-results"
              aria-label="Search workspaces and commands"
              autoComplete="off"
              placeholder="Search a workspace, project, or command"
              spellCheck={false}
              value={commandQuery}
              onChange={(event) => {
                onCommandQueryChange(event.currentTarget.value);
                onActiveCommandIndexChange(0);
              }}
              onKeyDown={(event) => {
                if (!matchingCommandItems.length) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  onActiveCommandIndexChange(
                    (activeCommandIndex + 1) % matchingCommandItems.length,
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  onActiveCommandIndexChange(
                    (activeCommandIndex - 1 + matchingCommandItems.length) %
                      matchingCommandItems.length,
                  );
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const active = matchingCommandItems[activeCommandIndex];
                  if (active && !active.disabled) active.run();
                }
              }}
            />
            <kbd>⌘K</kbd>
          </div>
          <div
            className={styles.commandList}
            data-ui="commands.results"
            data-ui-label="Command results"
          >
            {matchingCommandItems.length ? (
              <div id="command-results">
                {commandGroups.map((group) => {
                  const groupItems = matchingCommandItems.filter(
                    (item) => item.group === group,
                  );
                  if (!groupItems.length) return null;
                  return (
                    <section className={styles.commandGroup} key={group}>
                      <h3>{group}</h3>
                      {groupItems.map((item) => {
                        const itemIndex = matchingCommandItems.indexOf(item);
                        return (
                          <button
                            id={`command-${item.id}`}
                            key={item.id}
                            data-active={itemIndex === activeCommandIndex}
                            disabled={item.disabled}
                            onClick={item.run}
                            onMouseEnter={() =>
                              onActiveCommandIndexChange(itemIndex)
                            }
                            type="button"
                          >
                            <Glyph name={item.icon} size={17} />
                            <span>
                              <b>{item.label}</b>
                              <small>{item.description}</small>
                            </span>
                            <Glyph name="arrow" size={14} />
                          </button>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className={styles.commandEmpty}>
                <Glyph name="search" size={20} />
                <b>No matching results</b>
                <span>Try a workspace, project, or command.</span>
              </div>
            )}
          </div>
          <footer className={styles.commandFooter}>
            <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
            <span><kbd>↵</kbd> Open</span>
            <span><kbd>esc</kbd> Close</span>
          </footer>
          <Dialog.Close aria-label="Close command palette">
            <Glyph name="close" size={15} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});

import {
  Children,
  isValidElement,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import styles from "./SelectMenu.module.css";

interface SelectOption {
  disabled: boolean;
  label: ReactNode;
  textValue: string;
  value: string;
}

function plainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return Children.toArray(node).map(plainText).join("").replace(/\s+/g, " ").trim();
}

function optionsFromChildren(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean; value?: number | string }>(child)) {
      return [];
    }
    if (child.type !== "option") {
      return optionsFromChildren(child.props.children);
    }
    const label = child.props.children;
    return [{
      disabled: Boolean(child.props.disabled),
      label,
      textValue: plainText(label),
      value: String(child.props.value ?? plainText(label)),
    }];
  });
}

export function SelectMenu({
  "aria-label": ariaLabel,
  autoFocus,
  children,
  className,
  disabled = false,
  onChange,
  searchable = false,
  searchPlaceholder = "Search",
  value,
}: {
  "aria-label": string;
  autoFocus?: boolean;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  value: number | string;
}) {
  const options = optionsFromChildren(children);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogPortal, setDialogPortal] = useState<Element | null>(null);
  const setComboBoxRef = useCallback((node: HTMLDivElement | null) => {
    setDialogPortal(node?.closest('[role="dialog"]') ?? null);
  }, []);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    trigger.setAttribute("aria-label", ariaLabel);
    trigger.removeAttribute("aria-labelledby");
    trigger.setAttribute("role", "combobox");
    trigger.value = String(value);
    const handleChange = () => onChange(trigger.value);
    trigger.addEventListener("change", handleChange);
    return () => trigger.removeEventListener("change", handleChange);
  }, [ariaLabel, onChange, value]);

  if (searchable) {
    return (
      <ComboBox
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={styles.comboBox}
        isDisabled={disabled}
        menuTrigger="focus"
        onSelectionChange={(key) => {
          if (key !== null) onChange(String(key));
        }}
        ref={setComboBoxRef}
        selectedKey={String(value)}
      >
        <div className={`${styles.searchControl}${className ? ` ${className}` : ""}`}>
          <svg aria-hidden="true" className={styles.searchIcon} viewBox="0 0 16 16">
            <circle cx="7" cy="7" r="4.25" />
            <path d="m10.25 10.25 3 3" />
          </svg>
          <Input className={styles.searchInput} placeholder={searchPlaceholder} />
          <Button aria-label={`Show ${ariaLabel}`} className={styles.searchButton}>
            <svg aria-hidden="true" className={styles.chevron} viewBox="0 0 16 16">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </Button>
        </div>
        <Popover
          UNSTABLE_portalContainer={dialogPortal ?? undefined}
          className={styles.popover}
          placement="bottom start"
        >
          <ListBox className={styles.listBox} items={options}>
            {(option) => (
              <ListBoxItem
                className={styles.option}
                id={option.value}
                isDisabled={option.disabled}
                textValue={option.textValue}
              >
                {({ isSelected }) => (
                  <>
                    <span>{option.label}</span>
                    {isSelected && (
                      <svg aria-hidden="true" className={styles.check} viewBox="0 0 16 16">
                        <path d="m3 8.5 3 3 7-7" />
                      </svg>
                    )}
                  </>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
    );
  }

  return (
    <Select
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      isDisabled={disabled}
      onSelectionChange={(key) => onChange(String(key))}
      selectedKey={String(value)}
    >
      <Button
        aria-label={ariaLabel}
        className={`${styles.trigger}${className ? ` ${className}` : ""}`}
        data-select-trigger
        ref={triggerRef}
      >
        <SelectValue aria-hidden="true" className={styles.value} />
        <svg aria-hidden="true" className={styles.chevron} viewBox="0 0 16 16">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </Button>
      <Popover className={styles.popover} placement="bottom start">
        <ListBox className={styles.listBox} items={options}>
          {(option) => (
            <ListBoxItem
              className={styles.option}
              id={option.value}
              isDisabled={option.disabled}
              textValue={option.textValue}
            >
              {({ isSelected }) => (
                <>
                  <span>{option.label}</span>
                  {isSelected && (
                    <svg aria-hidden="true" className={styles.check} viewBox="0 0 16 16">
                      <path d="m3 8.5 3 3 7-7" />
                    </svg>
                  )}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

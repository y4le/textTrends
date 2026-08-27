import type { FormEvent, KeyboardEvent, ReactNode, Ref } from 'react';

export interface DockTakeoverInput {
  readonly id: string;
  readonly ariaLabel?: string;
  readonly type: 'search' | 'text';
  readonly value: string;
  readonly placeholder: string;
  readonly enterKeyHint: 'done' | 'search';
  readonly describedBy?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly onChange: (value: string) => void;
}

export function DockTakeover({
  mode,
  formLabel,
  label,
  input,
  status,
  statusTone = 'muted',
  controls,
  busy = false,
  onSubmit,
  onDismiss,
}: {
  readonly mode: 'add' | 'find';
  readonly formLabel: string;
  readonly label: string;
  readonly input: DockTakeoverInput;
  readonly status?: ReactNode;
  readonly statusTone?: 'muted' | 'error' | 'success';
  readonly controls: ReactNode;
  readonly busy?: boolean;
  readonly onSubmit: () => void;
  readonly onDismiss: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };
  const dismissOnEscape = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  };

  return (
    <form
      className="dock-takeover"
      data-dock-takeover={mode}
      aria-label={formLabel}
      aria-busy={busy}
      onSubmit={submit}
      onKeyDown={dismissOnEscape}
    >
      <div className="dock-takeover-field">
        <input
          ref={input.inputRef}
          id={input.id}
          type={input.type}
          value={input.value}
          aria-label={input.ariaLabel}
          aria-describedby={input.describedBy}
          placeholder={input.placeholder}
          enterKeyHint={input.enterKeyHint}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => input.onChange(event.currentTarget.value)}
        />
      </div>
      <div className="dock-takeover-upper">
        <label
          className="dock-takeover-label"
          htmlFor={input.id}
        >
          {label}
        </label>
        <span
          className="dock-takeover-status"
          data-tone={statusTone}
          aria-hidden="true"
        >
          {status}
        </span>
        <div className="dock-takeover-controls">{controls}</div>
      </div>
    </form>
  );
}

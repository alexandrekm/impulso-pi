// Custom editor that intercepts `/settings` so it opens the impulso-pi
// settings page instead of pi's built-in one.
//
// Why this exists: pi hardcodes `/settings` → its native selector inside the
// interactive editor's onSubmit (the check runs before extension commands
// are parsed), and there's no extension API to open pi's selector. The only
// hook that runs before that branch is the editor's own onSubmit, which pi
// re-assigns to its default when you call ctx.ui.setEditorComponent. So we
// override `onSubmit` as an instance accessor: pi's assignment lands in our
// setter (we keep the original), and our getter returns a wrapper that
// redirects `/settings` to the impulso overlay and delegates everything else
// (including `/settings pi`, which the original onSubmit treats as a bare
// `/settings` → pi's native menu) to the captured original.
//
// Trade-off: this replaces the editor factory for the whole session. It's
// the only way to override `/settings` from an extension; if another
// extension also needs a custom editor, only the last installed wins.

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

/** Minimal slice of ExtensionContext.ui we need to open the overlay. */
interface UiLike {
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => unknown,
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
}

/** Constructor of the impulso settings view (passed in to avoid a cycle). */
/** Constructor of the impulso settings view (passed in to avoid a cycle). */
export type ImpulsoViewCtor = new (
  theme: Theme,
  done: () => void,
  launch?: (command: string) => void,
) => unknown;

/** Build the editor factory passed to ctx.ui.setEditorComponent. */
export function makeImpulsoEditorFactory(
  ui: UiLike,
  View: ImpulsoViewCtor,
  launch?: (cmd: string) => void,
) {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): ImpulsoEditor =>
    new ImpulsoEditor(tui, theme, keybindings, ui, View, launch);
}

export class ImpulsoEditor extends CustomEditor {
  private originalSubmit?: (text: string) => void;
  private readonly ui: UiLike;
  private readonly View: ImpulsoViewCtor;
  private readonly launch: ((cmd: string) => void) | undefined;
  /** Stable wrapper returned via the onSubmit getter. */
  private wrappedSubmit?: (text: string) => void;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ui: UiLike,
    View: ImpulsoViewCtor,
    launch?: (cmd: string) => void,
  ) {
    super(tui, theme, keybindings);
    this.ui = ui;
    this.View = View;
    this.launch = launch;

    // Intercept onSubmit assignments from pi (setCustomEditorComponent does
    // `newEditor.onSubmit = this.defaultEditor.onSubmit`). The getter hands
    // back a wrapper that reroutes `/settings` to the impulso overlay.
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      enumerable: true,
      get: () => this.wrappedSubmit,
      set: (fn: ((text: string) => void) | undefined) => {
        this.originalSubmit = fn;
        this.wrappedSubmit = fn ? this.wrapSubmit(fn) : undefined;
      },
    });
  }

  private wrapSubmit(original: (text: string) => void): (text: string) => void {
    return (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "/settings") {
        // Open the impulso page instead of pi's native selector.
        void this.openImpulso();
        return;
      }
      if (trimmed === "/settings pi" || trimmed === "/pi-settings") {
        // Route to pi's native menu: the original onSubmit opens
        // showSettingsSelector() for a bare "/settings" argument.
        original("/settings");
        return;
      }
      original(text);
    };
  }

  private async openImpulso(): Promise<void> {
    try {
      await this.ui.custom<void>(
        (_tui: TUI, theme: Theme, _kb: KeybindingsManager, done: () => void) =>
          new this.View(theme, done, this.launch),
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "top-left",
            row: 0,
            col: 0,
            margin: 0,
          },
        },
      );
    } catch {
      // Fall back to pi's native menu if the overlay can't be shown.
      this.originalSubmit?.("/settings");
    }
  }
}

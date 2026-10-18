import {
  getCustomKeybindings,
  type KeyCombo,
} from "@termix-ssh/plugin-sdk/frontend";

/**
 * Ctrl+J (Cmd+J on a Mac) toggles the assistant until the user rebinds it.
 * The shell only runs saved bindings, so the default key is ours to handle;
 * once the user customizes it, their binding runs the action instead and
 * this listener stands down.
 */

export const TOGGLE_ACTION = "ai.toggleAssistant";

const isMac = () => /mac/i.test(navigator.platform || navigator.userAgent);

export function defaultCombo(): KeyCombo {
  const mac = isMac();
  return {
    key: "j",
    isCode: false,
    ctrl: !mac,
    alt: false,
    shift: false,
    meta: mac,
  };
}

export function installHotkey(toggle: () => void): () => void {
  let overridden = false;
  const load = () =>
    getCustomKeybindings()
      .then((bindings) => {
        overridden = bindings.some(
          (binding) => binding.overridesDefaultId === TOGGLE_ACTION,
        );
      })
      .catch(() => undefined);

  const onKeyDown = (event: KeyboardEvent) => {
    if (overridden || event.altKey || event.shiftKey) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "j") {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("[data-keybinding-recorder]")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };

  void load();
  window.addEventListener("customKeybindingsChanged", load);
  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    window.removeEventListener("customKeybindingsChanged", load);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

/** The default shortcut as shown to users. */
export function shortcutLabel(): string {
  return isMac() ? "Cmd+J" : "Ctrl+J";
}

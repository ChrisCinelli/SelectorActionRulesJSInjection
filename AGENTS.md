# AGENTS.md

Guidance for coding agents working on this repository.

## Project

This is a Manifest V3 Chrome Extension named **Selector Action Rules - JS Injection**. It lets users store per-domain rules that map CSS selectors to JavaScript action scripts, optionally filtered by URL regex. The UI is hosted in Chrome's Side Panel.

Read `README.md` and `creation_prompt.md` before making large behavioral changes.

## Architecture

- `manifest.json`: MV3 manifest. Uses `sidePanel`, not `default_popup`.
- `background.js`: service worker. Opens the Side Panel on normal toolbar click, runs the domain global script on toolbar double-click, and injects user-authored code with `chrome.userScripts.execute()`.
- `content.js`: loads the current domain's rules at `document_idle`, filters URL rules, and asks the background worker to inject matching CSS plus selector action bindings.
- `popup.html`, `popup.js`, `popup.css`: Side Panel UI. Despite the `popup` name, this is the Side Panel page.
- `icons/`: generated transparent PNG extension icons. Keep manifest icon paths synchronized with these files.
- `vendor/codemirror/`: local CodeMirror 5 assets. Do not replace with CDN scripts.
- `README.md`: user-facing documentation.
- `creation_prompt.md`: full one-shot prompt describing the desired extension behavior.

## Important Chrome Extension Constraints

- Do not add `default_popup` back to `manifest.json`. It prevents `chrome.action.onClicked` from firing.
- Use the Side Panel API for the UI:
  - single toolbar click opens the Side Panel
  - second toolbar click within the double-click window runs the global script
- Do not use `eval()` or `new Function()` in extension pages or content scripts. MV3 CSP and page CSP will break this.
- User-authored code must be injected with `chrome.userScripts.execute()`.
- Global scripts should run in `world: "MAIN"`.
- Selector action scripts should run in `world: "USER_SCRIPT"`.
- URL-rule CSS uses managed `<style>` tags injected by `chrome.scripting.executeScript()`. Upsert by URL-rule key on page load, and replace the whole managed CSS set on double-click refresh to avoid duplicate/stale styles.
- Chrome may require users to enable **Allow User Scripts** on the extension details page.

## Selector Action Behavior

Selector actions must use delegated document-level listeners, not `element.addEventListener()` on elements found at page load. Dynamic DOM elements must work.

The injected selector binding should:

- add a capture-phase listener on `document`
- resolve matching elements from `event.composedPath()` at event time
- call the user script with `this` set to the matched element
- pass the real DOM `event` as the function argument
- allow `event.preventDefault()`, `event.stopPropagation()`, and `event.stopImmediatePropagation()`
- log invalid selectors and runtime errors with selector/trigger/context details

If a child inside a matching element is clicked, `this` should be the matching ancestor element. If multiple ancestors match, execute from inner to outer unless propagation has been stopped.

## Storage Model

All persisted state lives in `chrome.storage.local` under domain keys such as `rules.example.com`.

Shape:

```json
{
  "rules.example.com": {
    "globalScript": "",
    "runOnPageLoad": false,
    "runOnExtensionClick": false,
    "urlRules": [
      {
        "urlRegex": "",
        "css": "",
        "selectorActions": [
          {
            "selector": ".button",
            "trigger": "onClick",
            "actionScript": "event.preventDefault(); this.disabled = true;"
          }
        ]
      }
    ]
  }
}
```

Every UI input, checkbox, dropdown, and CodeMirror editor change must autosave. Do not add a Save button.

The Side Panel is long-lived. It must refresh its loaded domain state when the active tab or active tab URL changes, instead of only reading the active tab once at startup.

Do not persist empty domain objects. If a domain has no meaningful global JavaScript, URL-rule CSS, or selector action JavaScript, autosave should remove `rules.<domain>` from `chrome.storage.local` while allowing blank draft UI to remain on screen.

## UI Notes

- The UI must remain usable at Side Panel widths. Avoid fixed wide body sizes.
- CodeMirror editors are created dynamically; refresh them after creation.
- CodeMirror uses local addons for `comment/comment.js`, `hint/css-hint.js`, `selection/active-line.js`, and `search/match-highlighter.js` plus `search/searchcursor.js` for match highlighting. Keep these local and loaded from `popup.html`.
- Keep editor shortcuts centralized in `EDITOR_EXTRA_KEYS` in `popup.js`. For shifted shortcuts, include CodeMirror's emitted modifier order such as `Shift-Alt-F` because raw `extraKeys` objects are not normalized.
- Each URL rule has a CSS CodeMirror editor. Keep its `css` field URL-rule scoped; empty regex means the CSS applies to all pages on that domain.
- New or empty action script editors should include a comment explaining:
  - `this = matched DOM element`
  - `event = real DOM event`
  - event cancellation/propagation methods are available
- Keep labels consistent with current behavior: `Run on extension icon double-click`.

## Validation

Run JavaScript syntax checks with the Node.js runtime available in the current environment:

```powershell
node --check background.js
node --check content.js
node --check popup.js
Get-Content manifest.json -Raw | ConvertFrom-Json | Out-Null
rg "new Function|eval\("
```

When behavior changes, verify at least:

- single toolbar click opens the Side Panel
- double toolbar click runs the global script
- action handlers work for elements inserted after page load
- `this` is the matched element
- `event.preventDefault()` prevents default browser behavior
- `event.stopPropagation()` blocks parent bubbling handlers
- CodeMirror initializes in the Side Panel at narrow width

## Editing Notes

- Keep CodeMirror assets local and minimal.
- Do not silently swallow errors in user scripts, regex parsing, or selector parsing.
- Keep source comments current when changing behavior. Prefer comments that explain Chrome API constraints, execution-world choices, generated user-script code, autosave lifecycle, and dynamic DOM delegation. Avoid comments that merely restate obvious syntax.
- If `manifest.json` changes, tell the user to reload the unpacked extension.
- This extension executes user-authored JavaScript. Preserve warnings and avoid adding behavior that runs imported scripts without user intent.

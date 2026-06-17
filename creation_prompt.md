# Creation Prompt

You are a senior Chrome Extension developer with deep expertise in Manifest V3, Chrome Side Panel, User Scripts API, content scripts, event delegation, CSP restrictions, and modern JavaScript tooling. Build a complete, production-ready Chrome Extension named **Selector Action Rules - JS Injection**.

## Goal

Create a Chrome Extension that lets users define JavaScript behavior for websites by associating CSS selectors with JavaScript actions, scoped per website domain and optionally filtered by URL regex. The extension must persist all state immediately to `chrome.storage.local`.

The final extension must be ready to load as an unpacked Chrome extension.

## Critical Implementation Requirements

Build this correctly in one pass. Avoid these known failure modes:

- Do **not** use `default_popup`. It prevents `chrome.action.onClicked` from firing and makes toolbar click behavior unreliable.
- Use the **Chrome Side Panel API** for the UI.
- A single extension icon click must open the Side Panel.
- A second icon click within a short double-click window, for example `500ms`, must run the current domain's global script if `runOnExtensionClick` is enabled.
- Do **not** execute user scripts with `eval()` or `new Function()` in the content script or extension page. MV3 CSP blocks that.
- Use `chrome.userScripts.execute()` for user-authored code.
- Selector action handlers must use delegated `document` event handling, not `element.addEventListener()` on elements found at page load. This is required so elements added after page load work.
- Selector action handlers must run in capture phase so user code can call `event.preventDefault()`, `event.stopPropagation()`, or `event.stopImmediatePropagation()` before normal bubbling handlers.
- In selector action scripts, `this` must be the matched DOM element and `event` must be the real DOM event.
- Log errors to the page console with context. Do not silently swallow invalid regexes, invalid selectors, or runtime script errors.

## Data Model

Store all state in `chrome.storage.local` under a key per domain:

```json
{
  "rules.example.com": {
    "globalScript": "console.log('hello')",
    "runOnPageLoad": true,
    "runOnExtensionClick": false,
    "urlRules": [
      {
        "urlRegex": "/checkout",
        "css": ".checkout-button { outline: 2px solid red; }",
        "selectorActions": [
          {
            "selector": "button.submit",
            "trigger": "onClick",
            "actionScript": "event.preventDefault(); this.disabled = true;"
          }
        ]
      }
    ]
  }
}
```

Fields:

- `globalScript`: string
- `runOnPageLoad`: boolean
- `runOnExtensionClick`: boolean, but the UI label must say **Run on extension icon double-click**
- `urlRules`: array
- `urlRegex`: string, optional; empty means all URLs on the domain
- `css`: string CSS to inject when the URL rule matches
- `selectorActions`: array
- `selector`: string CSS selector
- `trigger`: one of `onClick`, `onHover`, `onChange`, `onFocus`, `onBlur`, `onKeyup`
- `actionScript`: string JavaScript code

Trigger event mapping:

- `onClick` -> `click`
- `onHover` -> `mouseover`
- `onChange` -> `change`
- `onFocus` -> `focus`
- `onBlur` -> `blur`
- `onKeyup` -> `keyup`

## Required Files

Create:

- `manifest.json`
- `popup.html`
- `popup.js`
- `popup.css`
- `content.js`
- `background.js`
- `README.md`
- local CodeMirror assets under `vendor/codemirror/`

Use CodeMirror 5 locally, not from a CDN, because extension pages should not rely on remote JavaScript and MV3 CSP blocks many remote/inline script patterns. 
Include JavaScript and CSS modes so both script editors and URL-rule CSS editors have syntax highlighting.

## Manifest

Use Manifest V3 with:

- `minimum_chrome_version`: `135`
- permissions:
  - `storage`
  - `activeTab`
  - `scripting`
  - `tabs`
  - `userScripts`
  - `sidePanel`
- host permissions:
  - `<all_urls>`
- action:
  - `default_title`: `Selector Action Rules`
  - no `default_popup`
- side panel:
  - `default_path`: `popup.html`
- background:
  - service worker: `background.js`
- content script:
  - matches `<all_urls>`
  - `content.js`
  - `run_at`: `document_idle`

Users may need to enable **Allow User Scripts** on the extension details page in newer Chrome versions.

## Side Panel UI

The Side Panel should show rules for the active tab's domain. Extract the domain from the active tab URL using `chrome.tabs.query({ active: true, currentWindow: true })`.

Use `popup.html`, `popup.js`, and `popup.css` as the Side Panel UI.

The UI must contain:

1. Header
   - Extension title
   - Current domain
   - Save status text

2. Global Script Editor
   - CodeMirror JavaScript editor
   - JavaScript syntax highlighting
   - `show-hint` + `javascript-hint` autocomplete
   - match brackets
   - checkbox: `Run on page load`
   - checkbox: `Run on extension icon double-click`

3. URL Rules Section
   - List of URL rule blocks
   - Each URL rule block has:
     - text input labeled `URL Regex (optional)`
     - CodeMirror CSS editor labeled `Injected CSS (runs when this URL rule matches)`
     - list of selector/action rows
     - `Add Row` button
     - `Remove Rule` button
   - Each selector/action row has:
     - selector text input labeled `A. CSS querySelector`
     - trigger dropdown labeled `B. Trigger`
     - CodeMirror JavaScript editor labeled `C. Action Script (this = element, event = DOM event)`
     - `Remove` button
   - `Add URL Rule` button

4. Import / Export
   - Export button downloads all `chrome.storage.local` content as JSON
   - Import button opens a JSON file picker, parses JSON, merges/overwrites storage with `chrome.storage.local.set(imported)`, and refreshes the current domain UI

Every input, checkbox, dropdown, and CodeMirror editor change must autosave on `input` or `change`. There must be no Save button.

New or empty action script editors should start with this comment:

```js
// Context:
// this  = the matched DOM element
// event = the real DOM event
// You can call event.preventDefault(), event.stopPropagation(),
// or event.stopImmediatePropagation() here.

```

Make the Side Panel layout usable at narrow widths. Do not hard-code a wide popup width. Use responsive CSS with a minimum width around `320px`, full available width, clear spacing, and no horizontal overflow.

## Content Script

`content.js` is injected on all URLs at `document_idle`.

Behavior:

1. Determine current domain from `window.location.hostname`.
2. Load `rules.<domain>` from `chrome.storage.local`.
3. If no rules exist, do nothing.
4. For each URL rule:
   - If `urlRegex` is empty, it matches.
   - If `urlRegex` is set, compile it with `new RegExp(urlRegex)` and test `window.location.href`.
   - Log invalid regex errors with `{ urlRegex, href, urlRuleIndex, error }`.
   - If the rule matches and has non-empty `css`, send it to the background service worker:
     - `type: "INJECT_CSS_SOURCE"`
     - `css`
     - context with `urlRuleIndex`
5. For every matching selector action:
   - Validate trigger mapping.
   - Send a message to the background service worker to inject a delegated selector action binding:
     - `type: "INJECT_SELECTOR_ACTION"`
     - `selector`
     - `trigger`
     - `eventName`
     - `actionScript`
     - context with `urlRuleIndex` and `actionIndex`
6. If `runOnPageLoad` is true, send the global script to the background service worker:
   - `type: "RUN_GLOBAL_SCRIPT_SOURCE"`
   - `source: globalScript`
   - `reason: "page load"`

Do not use `eval()` or `new Function()` in `content.js`.

## Background Service Worker

`background.js` must handle:

1. Toolbar icon clicks:
   - On first click, immediately open the Side Panel with `chrome.sidePanel.open({ windowId })` or a valid `tabId` fallback.
   - Track the last click time and tab ID.
   - If another click on the same tab happens within `500ms`, run the current domain global script with reason `extension icon double-click`.
   - Do not delay opening the Side Panel while waiting to detect a double click. Delayed `openPopup()` / delayed open behavior is unreliable.

2. Messages:
   - `INJECT_CSS_SOURCE`
   - `INJECT_SELECTOR_ACTION`
   - `RUN_GLOBAL_SCRIPT_SOURCE`
   - `RUN_GLOBAL_SCRIPT_FOR_TAB`

3. User script execution:
   - Use `chrome.userScripts.execute()`.
   - For global scripts, execute in `world: "MAIN"` so the global script runs in page context.
   - For selector actions, execute in `world: "USER_SCRIPT"` to avoid page CSP and MV3 unsafe-eval restrictions.
   - Throw a useful error if `chrome.userScripts.execute` is unavailable, explaining that the user may need to enable **Allow User Scripts** and reload the extension.

4. CSS injection:
   - Use managed `<style>` tags injected by `chrome.scripting.executeScript()`, not repeated append-only CSS insertion.
   - Scope page-load CSS upserts to the sender tab and frame when `sender.frameId` is available.
   - Inject CSS only for URL rules that match the current page.
   - Use a stable key per URL rule, such as `url-rule-${urlRuleIndex}`, and replace an existing managed style tag with the same key instead of appending another one.
   - On extension icon double-click refresh, re-read storage, compute all matching URL-rule CSS for the active page, remove stale managed style tags, and replace/upsert the current set.
   - Log insertion/replacement errors with URL rule context.

## Delegated Selector Action Binding

The generated user script for selector actions must:

1. Validate the selector once:

```js
document.documentElement.matches(details.selector);
```

2. Add exactly one delegated listener for that selector/action:

```js
document.addEventListener(details.eventName, (event) => {
  const path = typeof event.composedPath === "function"
    ? event.composedPath()
    : fallbackPathFrom(event.target);

  const matchedElements = path.filter((candidate) => {
    return candidate instanceof Element && candidate.matches(details.selector);
  });

  for (const element of matchedElements) {
    try {
      (function (event) {
        // user actionScript goes here
      }).call(element, event);
    } catch (error) {
      console.error("[Selector Action Rules] Error executing action script", {
        selector: details.selector,
        trigger: details.trigger,
        element,
        event,
        context: details.context,
        error
      });
    }

    if (event.cancelBubble) {
      break;
    }
  }
}, { capture: true });
```

This is required so actions also work for elements added to the DOM after page load.

If a click happens on a child inside a matching element, `this` must be the matching ancestor element, not necessarily the original `event.target`.

If multiple ancestors match the selector, execute from innermost to outermost according to `event.composedPath()`, unless propagation has been stopped.

## Global Script Execution

Global scripts should be wrapped so errors are logged with reason context:

```js
(() => {
  const executionReason = "page load";
  try {
    (function () {
      // user globalScript goes here
    }).call(window);
  } catch (error) {
    console.error("[Selector Action Rules] Error executing global script", {
      reason: executionReason,
      error
    });
  }
})();
```

Do not use `new Function()` for this. Generate code passed to `chrome.userScripts.execute()`.

## README

Create a README explaining:

- what the extension does
- Side Panel behavior
- single-click opens Side Panel
- double-click runs global script when enabled
- storage model
- URL-rule scoped CSS injection
- supported triggers
- `this` and `event` in action scripts
- dynamic DOM support via delegated handlers
- local installation steps
- Allow User Scripts note
- security warning about executing user-authored JavaScript

## Verification

After implementation, run at least these checks:

- `manifest.json` parses as JSON.
- `background.js`, `content.js`, and `popup.js` pass JavaScript syntax checks.
- No `eval(` or `new Function` remains.
- A mocked or browser-based test verifies:
  - Side Panel open is called on first action click.
  - A second action click within `500ms` runs the global script.
  - Matching URL-rule CSS is injected and non-matching URL-rule CSS is not injected.
  - Re-running CSS injection for the same URL rule replaces the existing managed style tag instead of creating duplicates.
  - Delegated selector action works for an element inserted after the binding code ran.
  - `this` is the matched element.
  - `event.preventDefault()` prevents link navigation.
  - `event.stopPropagation()` prevents a parent bubbling handler.
  - CodeMirror initializes in the Side Panel UI at narrow width.

Deliver the complete extension files in the project root with self-consistent paths.

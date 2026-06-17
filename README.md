# Selector Action Rules - JS Injection

**Selector Action Rules - JS Injection** is a Chrome Extension for attaching JavaScript actions to CSS selectors on a per-domain basis. It lets you define rules for the current website, optionally limit them by URL regex, and run custom JavaScript when matching elements receive events such as clicks, hover, change, focus, blur, or keyup.

The extension UI opens in Chrome's Side Panel so it can stay visible while you work with the page.

## What It Does

- Stores rule sets per domain under keys such as `rules.example.com` in `chrome.storage.local`.
- Refreshes the Side Panel when you switch to another active tab or domain.
- Removes a domain key instead of keeping an empty object when no JavaScript or CSS is configured.
- Provides a CodeMirror JavaScript editor for a domain-level global script.
- Lets you add URL rule blocks, each with an optional regex matched against `window.location.href`.
- Lets each URL rule inject CSS when its regex matches; an empty regex injects on all pages for the domain.
- Replaces managed CSS on double-click refresh instead of appending duplicate styles.
- Lets you add selector/action rows inside each URL rule.
- Automatically saves every input, checkbox, dropdown, and editor change to `chrome.storage.local`.
- Imports and exports the full extension storage as JSON.
- Uses delegated document-level event handling, so selector actions work for elements added after page load.
- Runs selector action scripts with:
  - `this` set to the matched DOM element.
  - `event` set to the real DOM event.

Action scripts can call normal event methods, for example:

```js
event.preventDefault();
event.stopPropagation();
event.stopImmediatePropagation();
this.classList.add("handled");
```

## Global Script Behavior

Each domain can define one `globalScript`.

- `Run on page load`: runs the global script when a matching page finishes loading.
- `Run on extension icon double-click`: runs the global script when the extension toolbar icon is double-clicked.

A normal toolbar icon click opens the Side Panel.

## Editor Shortcuts

Code editors support common CodeMirror shortcuts:

- `Ctrl-A` / `Cmd-A`: select all
- `Ctrl-Z` / `Cmd-Z`: undo
- `Ctrl-Y` / `Ctrl-Shift-Z` / `Cmd-Shift-Z`: redo
- `Alt-Shift-F` / `Ctrl-Alt-F`: smart indent selection/current line
- `Ctrl-]` / `Cmd-]`: indent more
- `Ctrl-[` / `Cmd-[`: indent less
- `Ctrl-/` / `Cmd-/`: toggle comment
- `Ctrl-Space`: autocomplete

The JavaScript and CSS editors also highlight the active line and matching selected text.

## Rule Model

All state is stored in `chrome.storage.local` using this shape:

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

Supported triggers:

- `onClick`
- `onHover`
- `onChange`
- `onFocus`
- `onBlur`
- `onKeyup`

## Installing Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. On the extension details page, enable Allow User Scripts if Chrome shows that toggle.

The extension requires Chrome 135 or newer.

## Files

- `manifest.json`: MV3 manifest, permissions, content script registration, and Side Panel configuration.
- `background.js`: service worker for toolbar clicks, double-click global script execution, and user-script injection.
- `content.js`: loads the current domain rules and asks the service worker to inject selector action bindings.
- `popup.html`: Side Panel UI shell.
- `popup.js`: UI rendering, CodeMirror setup, autosave, import, and export.
- `popup.css`: Side Panel styling.
- `vendor/codemirror/`: local CodeMirror assets used by the editor.

## Notes

**IMPORTANT:** This extension executes user-authored JavaScript on websites you configure. Only use scripts you trust, and be careful when importing JSON from another source.

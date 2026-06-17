const TRIGGERS = [
  { value: "onClick", label: "onClick" },
  { value: "onHover", label: "onHover" },
  { value: "onChange", label: "onChange" },
  { value: "onFocus", label: "onFocus" },
  { value: "onBlur", label: "onBlur" },
  { value: "onKeyup", label: "onKeyup" }
];

const DEFAULT_STATE = {
  globalScript: "",
  runOnPageLoad: false,
  runOnExtensionClick: false,
  urlRules: []
};
const ACTION_SCRIPT_TEMPLATE = `// Context:
// this  = the matched DOM element
// event = the real DOM event
// You can call event.preventDefault(), event.stopPropagation(),
// or event.stopImmediatePropagation() here.

`;

const appEl = document.getElementById("app");
const emptyStateEl = document.getElementById("emptyState");
const domainLabelEl = document.getElementById("domainLabel");
const saveStatusEl = document.getElementById("saveStatus");
const globalScriptEl = document.getElementById("globalScript");
const runOnPageLoadEl = document.getElementById("runOnPageLoad");
const runOnExtensionClickEl = document.getElementById("runOnExtensionClick");
const urlRulesEl = document.getElementById("urlRules");
const addUrlRuleEl = document.getElementById("addUrlRule");
const exportButtonEl = document.getElementById("exportButton");
const importButtonEl = document.getElementById("importButton");
const importFileEl = document.getElementById("importFile");

let activeTab = null;
let domain = "";
let storageKey = "";
let state = structuredClone(DEFAULT_STATE);
let globalEditor = null;
let cssEditors = [];
let rowEditors = [];
let pendingWrites = new Map();
let saveInFlight = false;
let statusTimer = 0;
let activeLoadId = 0;

init().catch((error) => {
  console.error("[Selector Action Rules] Failed to initialize popup", error);
  domainLabelEl.textContent = "Unable to load current tab";
  showStatus("Error loading popup");
});

async function init() {
  bindStaticControls();
  bindTabRefreshControls();
  await loadActiveTabState({ force: true });
}

function bindStaticControls() {
  runOnPageLoadEl.addEventListener("change", () => {
    state.runOnPageLoad = runOnPageLoadEl.checked;
    persistState();
  });

  runOnExtensionClickEl.addEventListener("change", () => {
    state.runOnExtensionClick = runOnExtensionClickEl.checked;
    persistState();
  });

  addUrlRuleEl.addEventListener("click", () => {
    state.urlRules.push({
      urlRegex: "",
      css: "",
      selectorActions: []
    });
    persistState();
    renderUrlRules();
  });

  exportButtonEl.addEventListener("click", exportStorage);
  importButtonEl.addEventListener("click", () => importFileEl.click());
  importFileEl.addEventListener("change", importStorage);
}

function bindTabRefreshControls() {
  // The Side Panel stays open while users move between tabs, so refresh the
  // editor whenever Chrome reports a new active tab or a top-level URL change.
  chrome.tabs.onActivated.addListener(() => {
    loadActiveTabState().catch(handleActiveTabLoadError);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== activeTab?.id || (!changeInfo.url && changeInfo.status !== "complete")) {
      return;
    }

    loadActiveTabState().catch(handleActiveTabLoadError);
  });

  if (chrome.windows?.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener((windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) {
        return;
      }

      loadActiveTabState().catch(handleActiveTabLoadError);
    });
  }
}

async function loadActiveTabState({ force = false } = {}) {
  const loadId = ++activeLoadId;
  const nextTab = await getActiveTab();
  const nextDomain = getHostname(nextTab?.url);
  const nextStorageKey = nextDomain ? `rules.${nextDomain}` : "";

  if (loadId !== activeLoadId) {
    return;
  }

  activeTab = nextTab;

  if (!nextDomain) {
    domain = "";
    storageKey = "";
    state = structuredClone(DEFAULT_STATE);
    disposeEditors();
    domainLabelEl.textContent = "Unsupported page";
    appEl.hidden = true;
    emptyStateEl.hidden = false;
    return;
  }

  if (!force && nextStorageKey === storageKey) {
    domain = nextDomain;
    domainLabelEl.textContent = domain;
    return;
  }

  const stored = await chrome.storage.local.get(nextStorageKey);

  if (loadId !== activeLoadId) {
    return;
  }

  domain = nextDomain;
  storageKey = nextStorageKey;
  state = normalizeState(stored[storageKey]);
  await removeEmptyStoredState(storageKey, stored[storageKey], state);
  domainLabelEl.textContent = domain;
  appEl.hidden = false;
  emptyStateEl.hidden = true;
  render();
}

function handleActiveTabLoadError(error) {
  console.error("[Selector Action Rules] Failed to refresh active tab", error);
  domainLabelEl.textContent = "Unable to load current tab";
  showStatus("Load failed");
}

function render() {
  // Rebuild CodeMirror instances on render because URL rules/rows are
  // dynamic DOM. Always tear down the previous editor before recreating it.
  runOnPageLoadEl.checked = state.runOnPageLoad;
  runOnExtensionClickEl.checked = state.runOnExtensionClick;

  disposeEditors();

  globalScriptEl.value = state.globalScript;
  globalEditor = createCodeEditor(globalScriptEl, state.globalScript, (value) => {
    state.globalScript = value;
    persistState();
  }, { mode: "javascript", autocomplete: true });

  renderUrlRules();
}

function renderUrlRules() {
  // Row editors live inside generated rule blocks, so they must be disposed
  // before the container is cleared to keep CodeMirror state in sync.
  disposeDynamicEditors();
  urlRulesEl.textContent = "";

  if (!state.urlRules.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No URL rules yet.";
    urlRulesEl.append(empty);
    return;
  }

  state.urlRules.forEach((rule, ruleIndex) => {
    const block = document.createElement("article");
    block.className = "rule-block";

    const heading = document.createElement("div");
    heading.className = "rule-heading";

    const title = document.createElement("h3");
    title.textContent = `URL Rule ${ruleIndex + 1}`;

    const removeRuleButton = document.createElement("button");
    removeRuleButton.type = "button";
    removeRuleButton.className = "button danger compact";
    removeRuleButton.textContent = "Remove Rule";
    removeRuleButton.addEventListener("click", () => {
      state.urlRules.splice(ruleIndex, 1);
      persistState();
      renderUrlRules();
    });

    heading.append(title, removeRuleButton);

    const fields = document.createElement("div");
    fields.className = "rule-fields";

    const regexField = document.createElement("label");
    regexField.className = "field";
    const regexLabel = document.createElement("span");
    regexLabel.className = "field-label";
    regexLabel.textContent = "URL Regex (optional)";
    const regexInput = document.createElement("input");
    regexInput.type = "text";
    regexInput.value = rule.urlRegex;
    regexInput.placeholder = "example: /checkout|/cart";
    regexInput.addEventListener("input", () => {
      rule.urlRegex = regexInput.value;
      persistState();
    });
    regexField.append(regexLabel, regexInput);

    const cssField = document.createElement("label");
    cssField.className = "field";
    const cssLabel = document.createElement("span");
    cssLabel.className = "field-label";
    cssLabel.textContent = "Injected CSS (runs when this URL rule matches)";
    const cssTextarea = document.createElement("textarea");
    cssTextarea.value = rule.css;
    cssTextarea.setAttribute("aria-label", `Injected CSS for URL rule ${ruleIndex + 1}`);
    cssField.append(cssLabel, cssTextarea);

    const rowsContainer = document.createElement("div");
    rowsContainer.className = "selector-actions";

    if (!rule.selectorActions.length) {
      const emptyRows = document.createElement("div");
      emptyRows.className = "empty-list";
      emptyRows.textContent = "No selector actions in this rule.";
      rowsContainer.append(emptyRows);
    } else {
      rule.selectorActions.forEach((row, rowIndex) => {
        rowsContainer.append(createSelectorActionRow(rule, ruleIndex, row, rowIndex));
      });
    }

    const addRowButton = document.createElement("button");
    addRowButton.type = "button";
    addRowButton.className = "button compact";
    addRowButton.textContent = "Add Row";
    addRowButton.addEventListener("click", () => {
      rule.selectorActions.push({
        selector: "",
        trigger: "onClick",
        actionScript: ACTION_SCRIPT_TEMPLATE
      });
      persistState();
      renderUrlRules();
    });

    fields.append(regexField, cssField, rowsContainer, addRowButton);
    block.append(heading, fields);
    urlRulesEl.append(block);

    queueMicrotask(() => {
      // CSS is scoped by the URL rule, so it is injected only when this rule's
      // regex matches the current page. Empty regex means all pages on domain.
      const editor = createCodeEditor(cssTextarea, rule.css, (value) => {
        rule.css = value;
        persistState();
      }, { mode: "css" });
      cssEditors.push(editor);
    });
  });
}

function createSelectorActionRow(rule, ruleIndex, row, rowIndex) {
  const wrapper = document.createElement("div");
  wrapper.className = "selector-row";

  const toolbar = document.createElement("div");
  toolbar.className = "row-toolbar";

  const title = document.createElement("h3");
  title.textContent = `Row ${rowIndex + 1}`;

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "button danger compact";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => {
    rule.selectorActions.splice(rowIndex, 1);
    persistState();
    renderUrlRules();
  });

  toolbar.append(title, removeButton);

  const fields = document.createElement("div");
  fields.className = "row-fields";

  const selectorField = document.createElement("label");
  selectorField.className = "field";
  const selectorLabel = document.createElement("span");
  selectorLabel.className = "field-label";
  selectorLabel.textContent = "A. CSS querySelector";
  const selectorInput = document.createElement("input");
  selectorInput.type = "text";
  selectorInput.value = row.selector;
  selectorInput.placeholder = ".button, #checkout, [data-action]";
  selectorInput.addEventListener("input", () => {
    row.selector = selectorInput.value;
    persistState();
  });
  selectorField.append(selectorLabel, selectorInput);

  const triggerField = document.createElement("label");
  triggerField.className = "field";
  const triggerLabel = document.createElement("span");
  triggerLabel.className = "field-label";
  triggerLabel.textContent = "B. Trigger";
  const triggerSelect = document.createElement("select");
  TRIGGERS.forEach((trigger) => {
    const option = document.createElement("option");
    option.value = trigger.value;
    option.textContent = trigger.label;
    option.selected = row.trigger === trigger.value;
    triggerSelect.append(option);
  });
  triggerSelect.addEventListener("change", () => {
    row.trigger = triggerSelect.value;
    persistState();
  });
  triggerField.append(triggerLabel, triggerSelect);

  fields.append(selectorField, triggerField);

  const actionField = document.createElement("label");
  actionField.className = "field";
  const actionLabel = document.createElement("span");
  actionLabel.className = "field-label";
  actionLabel.textContent = "C. Action Script (this = element, event = DOM event)";
  const textarea = document.createElement("textarea");
  if (!row.actionScript.trim()) {
    row.actionScript = ACTION_SCRIPT_TEMPLATE;
  }
  textarea.value = row.actionScript;
  textarea.setAttribute("aria-label", `Action script for URL rule ${ruleIndex + 1}, row ${rowIndex + 1}`);
  actionField.append(actionLabel, textarea);

  wrapper.append(toolbar, fields, actionField);

  queueMicrotask(() => {
    // Initialize after the textarea is attached; CodeMirror measures DOM
    // dimensions during setup and refresh.
    const editor = createCodeEditor(textarea, row.actionScript, (value) => {
      row.actionScript = value;
      persistState();
    }, { mode: "javascript", autocomplete: true });
    rowEditors.push(editor);
  });

  return wrapper;
}

function createCodeEditor(textarea, value, onChange, options = {}) {
  textarea.value = value || "";
  const { mode = "javascript", autocomplete = false } = options;
  const editor = CodeMirror.fromTextArea(textarea, {
    mode,
    lineNumbers: true,
    matchBrackets: true,
    tabSize: 2,
    indentUnit: 2,
    lineWrapping: true,
    extraKeys: autocomplete ? { "Ctrl-Space": "autocomplete" } : {},
    hintOptions: autocomplete ? { completeSingle: false } : undefined
  });

  editor.setSize("100%", null);
  editor.on("change", (instance) => onChange(instance.getValue()));
  setTimeout(() => editor.refresh(), 0);
  return editor;
}

async function persistState() {
  if (!storageKey) {
    return;
  }

  // Autosave can fire rapidly while typing. Keep only the newest persistable
  // snapshot per domain while a chrome.storage write is in flight.
  const nextSnapshot = createStorageSnapshot(state);
  pendingWrites.set(storageKey, nextSnapshot);
  showStatus(nextSnapshot ? "Saving..." : "Clearing...");

  if (saveInFlight) {
    return;
  }

  saveInFlight = true;
  try {
    while (pendingWrites.size) {
      const [nextStorageKey, snapshot] = pendingWrites.entries().next().value;
      pendingWrites.delete(nextStorageKey);

      if (snapshot) {
        await chrome.storage.local.set({ [nextStorageKey]: snapshot });
      } else {
        await chrome.storage.local.remove(nextStorageKey);
      }
    }

    showStatus("Saved");
  } catch (error) {
    console.error("[Selector Action Rules] Failed to save rules", {
      pendingKeys: Array.from(pendingWrites.keys()),
      error
    });
    showStatus("Save failed");
  } finally {
    saveInFlight = false;
  }
}

async function exportStorage() {
  try {
    const allStorage = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(allStorage, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `selector-action-rules-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("Exported");
  } catch (error) {
    console.error("[Selector Action Rules] Export failed", error);
    showStatus("Export failed");
  }
}

async function importStorage(event) {
  const [file] = event.target.files || [];
  importFileEl.value = "";

  if (!file) {
    return;
  }

  try {
    const imported = JSON.parse(await file.text());
    if (!isPlainObject(imported) || Array.isArray(imported)) {
      throw new Error("Imported JSON must be an object.");
    }

    await chrome.storage.local.set(imported);
    const stored = await chrome.storage.local.get(storageKey);
    state = normalizeState(stored[storageKey]);
    render();
    showStatus("Imported");
  } catch (error) {
    console.error("[Selector Action Rules] Import failed", error);
    showStatus("Import failed");
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tab || null;
}

function getHostname(url) {
  try {
    return url ? new URL(url).hostname : "";
  } catch (error) {
    return "";
  }
}

function normalizeState(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    globalScript: typeof source.globalScript === "string" ? source.globalScript : "",
    runOnPageLoad: Boolean(source.runOnPageLoad),
    runOnExtensionClick: Boolean(source.runOnExtensionClick),
    urlRules: Array.isArray(source.urlRules)
      ? source.urlRules.map(normalizeUrlRule)
      : []
  };
}

function normalizeUrlRule(rule) {
  const source = isPlainObject(rule) ? rule : {};
  return {
    urlRegex: typeof source.urlRegex === "string" ? source.urlRegex : "",
    css: typeof source.css === "string" ? source.css : "",
    selectorActions: Array.isArray(source.selectorActions)
      ? source.selectorActions.map(normalizeSelectorAction)
      : []
  };
}

function normalizeSelectorAction(action) {
  const source = isPlainObject(action) ? action : {};
  const trigger = TRIGGERS.some((item) => item.value === source.trigger)
    ? source.trigger
    : "onClick";

  return {
    selector: typeof source.selector === "string" ? source.selector : "",
    trigger,
    actionScript: typeof source.actionScript === "string" ? source.actionScript : ""
  };
}

function createStorageSnapshot(value) {
  const normalized = normalizeState(value);
  const hasGlobalScript = hasMeaningfulJavaScript(normalized.globalScript);
  const urlRules = normalized.urlRules
    .map(createStorageUrlRule)
    .filter(Boolean);

  if (!hasGlobalScript && !urlRules.length) {
    return null;
  }

  return {
    globalScript: hasGlobalScript ? normalized.globalScript : "",
    runOnPageLoad: normalized.runOnPageLoad,
    runOnExtensionClick: normalized.runOnExtensionClick,
    urlRules
  };
}

function createStorageUrlRule(rule) {
  const hasCss = hasMeaningfulCss(rule.css);
  const selectorActions = rule.selectorActions
    .map(createStorageSelectorAction)
    .filter(Boolean);

  if (!hasCss && !selectorActions.length) {
    return null;
  }

  return {
    urlRegex: rule.urlRegex,
    css: hasCss ? rule.css : "",
    selectorActions
  };
}

function createStorageSelectorAction(action) {
  if (!hasMeaningfulJavaScript(action.actionScript)) {
    return null;
  }

  return {
    selector: action.selector,
    trigger: action.trigger,
    actionScript: action.actionScript
  };
}

async function removeEmptyStoredState(nextStorageKey, storedValue, nextState) {
  // Older builds could leave `{ globalScript: "", urlRules: [] }` behind.
  // Clean those up when loaded so storage only contains actionable domains.
  if (typeof storedValue === "undefined" || createStorageSnapshot(nextState)) {
    return;
  }

  try {
    await chrome.storage.local.remove(nextStorageKey);
  } catch (error) {
    console.error("[Selector Action Rules] Failed to remove empty rules", {
      storageKey: nextStorageKey,
      error
    });
  }
}

function hasMeaningfulJavaScript(source) {
  const trimmed = typeof source === "string" ? source.trim() : "";
  return Boolean(trimmed && trimmed !== ACTION_SCRIPT_TEMPLATE.trim());
}

function hasMeaningfulCss(source) {
  return Boolean(typeof source === "string" && source.trim());
}

function disposeEditors() {
  if (globalEditor) {
    globalEditor.toTextArea();
    globalEditor = null;
  }

  disposeDynamicEditors();
}

function disposeDynamicEditors() {
  cssEditors.forEach((editor) => editor.toTextArea());
  rowEditors.forEach((editor) => editor.toTextArea());
  cssEditors = [];
  rowEditors = [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function showStatus(message) {
  saveStatusEl.textContent = message;
  clearTimeout(statusTimer);
  if (message === "Saved" || message === "Exported" || message === "Imported") {
    statusTimer = setTimeout(() => {
      saveStatusEl.textContent = "";
    }, 1600);
  }
}

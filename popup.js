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
let rowEditors = [];
let pendingSnapshot = null;
let saveInFlight = false;
let statusTimer = 0;

init().catch((error) => {
  console.error("[Selector Action Rules] Failed to initialize popup", error);
  domainLabelEl.textContent = "Unable to load current tab";
  showStatus("Error loading popup");
});

async function init() {
  activeTab = await getActiveTab();
  domain = getHostname(activeTab?.url);

  if (!domain) {
    domainLabelEl.textContent = "Unsupported page";
    appEl.hidden = true;
    emptyStateEl.hidden = false;
    return;
  }

  storageKey = `rules.${domain}`;
  domainLabelEl.textContent = domain;

  const stored = await chrome.storage.local.get(storageKey);
  state = normalizeState(stored[storageKey]);

  appEl.hidden = false;
  emptyStateEl.hidden = true;
  render();
  bindStaticControls();
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
      selectorActions: []
    });
    persistState();
    renderUrlRules();
  });

  exportButtonEl.addEventListener("click", exportStorage);
  importButtonEl.addEventListener("click", () => importFileEl.click());
  importFileEl.addEventListener("change", importStorage);
}

function render() {
  // Rebuild CodeMirror instances on render because URL rules/rows are
  // dynamic DOM. Always tear down the previous editor before recreating it.
  runOnPageLoadEl.checked = state.runOnPageLoad;
  runOnExtensionClickEl.checked = state.runOnExtensionClick;

  if (globalEditor) {
    globalEditor.toTextArea();
    globalEditor = null;
  }

  globalScriptEl.value = state.globalScript;
  globalEditor = createCodeEditor(globalScriptEl, state.globalScript, (value) => {
    state.globalScript = value;
    persistState();
  });

  renderUrlRules();
}

function renderUrlRules() {
  // Row editors live inside generated rule blocks, so they must be disposed
  // before the container is cleared to keep CodeMirror state in sync.
  rowEditors.forEach((editor) => editor.toTextArea());
  rowEditors = [];
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

    fields.append(regexField, rowsContainer, addRowButton);
    block.append(heading, fields);
    urlRulesEl.append(block);
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
    });
    rowEditors.push(editor);
  });

  return wrapper;
}

function createCodeEditor(textarea, value, onChange) {
  textarea.value = value || "";
  const editor = CodeMirror.fromTextArea(textarea, {
    mode: "javascript",
    lineNumbers: true,
    matchBrackets: true,
    tabSize: 2,
    indentUnit: 2,
    lineWrapping: true,
    extraKeys: {
      "Ctrl-Space": "autocomplete"
    },
    hintOptions: {
      completeSingle: false
    }
  });

  editor.setSize("100%", null);
  editor.on("change", (instance) => onChange(instance.getValue()));
  setTimeout(() => editor.refresh(), 0);
  return editor;
}

async function persistState() {
  // Autosave can fire rapidly while typing. Keep only the newest normalized
  // snapshot queued while a chrome.storage write is in flight.
  pendingSnapshot = normalizeState(state);
  showStatus("Saving...");

  if (saveInFlight) {
    return;
  }

  saveInFlight = true;
  try {
    while (pendingSnapshot) {
      const snapshot = pendingSnapshot;
      pendingSnapshot = null;
      await chrome.storage.local.set({ [storageKey]: snapshot });
    }
    showStatus("Saved");
  } catch (error) {
    console.error("[Selector Action Rules] Failed to save rules", {
      storageKey,
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

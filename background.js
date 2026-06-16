const BACKGROUND_LOG_PREFIX = "[Selector Action Rules]";
const TRIGGER_EVENTS = {
  onClick: "click",
  onHover: "mouseover",
  onChange: "change",
  onFocus: "focus",
  onBlur: "blur",
  onKeyup: "keyup"
};
const MESSAGE_TYPES = [
  "INJECT_SELECTOR_ACTION",
  "RUN_GLOBAL_SCRIPT_FOR_TAB",
  "RUN_GLOBAL_SCRIPT_SOURCE"
];

chrome.action.onClicked.addListener((tab) => {
  // This fires only if the extension action has no default_popup.
  // popup.js sends the same request when the configured popup opens.
  runGlobalScriptForTab(tab, "extension icon click").catch((error) => {
    console.error(`${BACKGROUND_LOG_PREFIX} Failed to handle action click`, {
      tabId: tab?.id,
      error
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !MESSAGE_TYPES.includes(message.type)) {
    return false;
  }

  handleRuntimeMessage(message, sender)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error(`${BACKGROUND_LOG_PREFIX} Failed to handle runtime request`, {
        message,
        sender,
        error
      });
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function handleRuntimeMessage(message, sender) {
  if (message.type === "INJECT_SELECTOR_ACTION") {
    await handleInjectSelectorActionMessage(message, sender);
    return;
  }

  if (message.type === "RUN_GLOBAL_SCRIPT_SOURCE") {
    const tabId = sender.tab?.id;

    if (!Number.isInteger(tabId)) {
      throw new Error("A sender tab is required to run a page-load global script.");
    }

    await injectGlobalScript(tabId, message.source, message.reason || "page load", sender.frameId);
    return;
  }

  const tabId = Number(message.tabId);

  if (!Number.isInteger(tabId)) {
    throw new Error("A valid tabId is required.");
  }

  const tab = await chrome.tabs.get(tabId);
  await runGlobalScriptForTab(tab, message.reason || "extension icon click");
}

async function handleInjectSelectorActionMessage(message, sender) {
  const tabId = sender.tab?.id;

  if (!Number.isInteger(tabId)) {
    throw new Error("A sender tab is required to inject a selector action.");
  }

  const eventName = typeof message.eventName === "string"
    ? message.eventName
    : TRIGGER_EVENTS[message.trigger];

  if (!eventName) {
    throw new Error(`Unsupported trigger: ${message.trigger}`);
  }

  await injectSelectorActionBinding(tabId, sender.frameId, {
    selector: typeof message.selector === "string" ? message.selector : "",
    trigger: typeof message.trigger === "string" ? message.trigger : "",
    eventName,
    actionScript: typeof message.actionScript === "string" ? message.actionScript : "",
    context: isPlainObject(message.context) ? message.context : {}
  });
}

async function runGlobalScriptForTab(tab, reason) {
  if (!tab?.id || !tab.url) {
    return;
  }

  const domain = getHostname(tab.url);

  if (!domain) {
    return;
  }

  const storageKey = `rules.${domain}`;
  const stored = await chrome.storage.local.get(storageKey);
  const ruleSet = normalizeRuleSet(stored[storageKey]);

  if (!ruleSet?.runOnExtensionClick) {
    return;
  }

  if (!ruleSet.globalScript.trim()) {
    return;
  }

  await injectGlobalScript(tab.id, ruleSet.globalScript, reason);
}

async function injectGlobalScript(tabId, source, reason, frameId) {
  if (typeof source !== "string" || !source.trim()) {
    return;
  }

  await executeUserScript({
    tabId,
    frameId,
    world: "MAIN",
    code: buildGlobalScriptCode(source, reason)
  });
}

async function injectSelectorActionBinding(tabId, frameId, details) {
  if (!details.selector.trim() || !details.actionScript.trim()) {
    return;
  }

  await executeUserScript({
    tabId,
    frameId,
    code: buildSelectorActionBindingCode(details)
  });
}

async function executeUserScript({ tabId, frameId, world = "USER_SCRIPT", code }) {
  if (!chrome.userScripts?.execute) {
    throw new Error(
      "chrome.userScripts.execute is unavailable. Enable the extension's Allow User Scripts toggle in chrome://extensions, then reload the extension."
    );
  }

  const target = { tabId };

  if (Number.isInteger(frameId)) {
    target.frameIds = [frameId];
  }

  const results = await chrome.userScripts.execute({
    target,
    injectImmediately: true,
    world,
    js: [{ code }]
  });
  const errors = results
    .filter((result) => result.error)
    .map((result) => result.error);

  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

function buildGlobalScriptCode(source, reason) {
  return `
(() => {
  const executionReason = ${JSON.stringify(reason)};
  try {
    (function () {
${source}
    }).call(window);
  } catch (error) {
    console.error(${JSON.stringify(`${BACKGROUND_LOG_PREFIX} Error executing global script`)}, {
      reason: executionReason,
      error
    });
  }
})();
`;
}

function buildSelectorActionBindingCode(details) {
  const safeDetails = {
    selector: details.selector,
    trigger: details.trigger,
    eventName: details.eventName,
    context: details.context
  };

  return `
(() => {
  const details = ${JSON.stringify(safeDetails)};
  let elements = [];

  try {
    elements = Array.from(document.querySelectorAll(details.selector));
  } catch (error) {
    console.error(${JSON.stringify(`${BACKGROUND_LOG_PREFIX} Invalid selector`)}, {
      selector: details.selector,
      trigger: details.trigger,
      context: details.context,
      error
    });
    return;
  }

  elements.forEach((element) => {
    element.addEventListener(details.eventName, function (event) {
      try {
        (function (event) {
${details.actionScript}
        }).call(this, event);
      } catch (error) {
        console.error(${JSON.stringify(`${BACKGROUND_LOG_PREFIX} Error executing action script`)}, {
          selector: details.selector,
          trigger: details.trigger,
          element: this,
          event,
          context: details.context,
          error
        });
      }
    }, { capture: true });
  });
})();
`;
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function normalizeRuleSet(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  return {
    globalScript: typeof value.globalScript === "string" ? value.globalScript : "",
    runOnPageLoad: Boolean(value.runOnPageLoad),
    runOnExtensionClick: Boolean(value.runOnExtensionClick),
    urlRules: Array.isArray(value.urlRules) ? value.urlRules : []
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

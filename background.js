const BACKGROUND_LOG_PREFIX = "[Selector Action Rules]";

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
  if (!message || !["RUN_GLOBAL_SCRIPT_FOR_TAB", "RUN_GLOBAL_SCRIPT_SOURCE"].includes(message.type)) {
    return false;
  }

  handleRunGlobalScriptMessage(message, sender)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error(`${BACKGROUND_LOG_PREFIX} Failed to run global script for popup request`, {
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

async function handleRunGlobalScriptMessage(message, sender) {
  if (message.type === "RUN_GLOBAL_SCRIPT_SOURCE") {
    const tabId = sender.tab?.id;

    if (!Number.isInteger(tabId)) {
      throw new Error("A sender tab is required to run a page-load global script.");
    }

    await injectGlobalScript(tabId, message.source, message.reason || "page load");
    return;
  }

  const tabId = Number(message.tabId);

  if (!Number.isInteger(tabId)) {
    throw new Error("A valid tabId is required.");
  }

  const tab = await chrome.tabs.get(tabId);
  await runGlobalScriptForTab(tab, message.reason || "extension icon click");
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

async function injectGlobalScript(tabId, source, reason) {
  if (typeof source !== "string" || !source.trim()) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (source, executionReason) => {
      try {
        const runner = new Function(source);
        runner.call(window);
      } catch (error) {
        console.error("[Selector Action Rules] Error executing global script", {
          reason: executionReason,
          error
        });
      }
    },
    args: [source, reason]
  });
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

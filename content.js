const SELECTOR_ACTION_LOG_PREFIX = "[Selector Action Rules]";
const TRIGGER_EVENTS = {
  onClick: "click",
  onHover: "mouseover",
  onChange: "change",
  onFocus: "focus",
  onBlur: "blur",
  onKeyup: "keyup"
};

initSelectorActionRules().catch((error) => {
  console.error(`${SELECTOR_ACTION_LOG_PREFIX} Failed to initialize content script`, {
    href: window.location.href,
    error
  });
});

async function initSelectorActionRules() {
  const domain = window.location.hostname;

  if (!domain) {
    return;
  }

  const storageKey = `rules.${domain}`;
  const stored = await chrome.storage.local.get(storageKey);
  const ruleSet = normalizeRuleSet(stored[storageKey]);

  if (!ruleSet) {
    return;
  }

  attachSelectorActions(ruleSet);

  if (ruleSet.runOnPageLoad) {
    await executeGlobalScript(ruleSet.globalScript, "page load");
  }
}

function attachSelectorActions(ruleSet) {
  ruleSet.urlRules.forEach((urlRule, urlRuleIndex) => {
    if (!matchesCurrentUrl(urlRule.urlRegex, urlRuleIndex)) {
      return;
    }

    urlRule.selectorActions.forEach((selectorAction, actionIndex) => {
      const eventName = TRIGGER_EVENTS[selectorAction.trigger];

      if (!eventName) {
        console.error(`${SELECTOR_ACTION_LOG_PREFIX} Unsupported trigger`, {
          trigger: selectorAction.trigger,
          urlRuleIndex,
          actionIndex
        });
        return;
      }

      if (!selectorAction.selector.trim()) {
        return;
      }

      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selectorAction.selector));
        console.log(elements);
      } catch (error) {
        console.error(`${SELECTOR_ACTION_LOG_PREFIX} Invalid selector`, {
          selector: selectorAction.selector,
          urlRuleIndex,
          actionIndex,
          error
        });
        return;
      }

      elements.forEach((element) => {
        element.addEventListener(eventName, (event) => {
          executeActionScript(selectorAction, element, event, {
            urlRuleIndex,
            actionIndex
          });
        });
      });
    });
  });
}

function matchesCurrentUrl(urlRegex, urlRuleIndex) {
  if (!urlRegex.trim()) {
    return true;
  }

  try {
    return new RegExp(urlRegex).test(window.location.href);
  } catch (error) {
    console.error(`${SELECTOR_ACTION_LOG_PREFIX} Invalid URL regex`, {
      urlRegex,
      href: window.location.href,
      urlRuleIndex,
      error
    });
    return false;
  }
}

function executeActionScript(selectorAction, element, event, context) {
  try {
    const runner = new Function("event", selectorAction.actionScript);
    runner.call(element, event);
  } catch (error) {
    console.error(`${SELECTOR_ACTION_LOG_PREFIX} Error executing action script`, {
      selector: selectorAction.selector,
      trigger: selectorAction.trigger,
      element,
      ...context,
      error
    });
  }
}

async function executeGlobalScript(globalScript, reason) {
  if (!globalScript.trim()) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "RUN_GLOBAL_SCRIPT_SOURCE",
      source: globalScript,
      reason
    });

    if (response && response.ok === false) {
      throw new Error(response.error || "Background script rejected global script execution.");
    }
  } catch (error) {
    console.error(`${SELECTOR_ACTION_LOG_PREFIX} Error requesting global script execution`, {
      reason,
      href: window.location.href,
      error
    });
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
    urlRules: Array.isArray(value.urlRules)
      ? value.urlRules.map(normalizeUrlRule)
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
  return {
    selector: typeof source.selector === "string" ? source.selector : "",
    trigger: typeof source.trigger === "string" ? source.trigger : "onClick",
    actionScript: typeof source.actionScript === "string" ? source.actionScript : ""
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

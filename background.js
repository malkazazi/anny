const REFERENCE_PICKER_KEY = "anny:reference-picker";

const EXTENSION_MESSAGES = new Set([
  "annotator:get-state",
  "annotator:open-toolbar",
  "annotator:toggle-toolbar",
  "annotator:toggle-feedback",
  "annotator:set-feedback",
  "annotator:toggle-markers",
  "annotator:toggle-pause",
  "annotator:clear",
  "annotator:export"
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "annotator:capture-visible-tab") {
    captureVisibleTab(sender)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Unable to capture visible tab."
        });
      });

    return true;
  }

  if (message?.type === "annotator:reference-picker-started") {
    rememberReferencePickerTab(sender)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Unable to remember the reference picker tab."
        });
      });

    return true;
  }

  if (message?.type === "annotator:reference-picker-ended") {
    sendResponse({ ok: true });
    return false;
  }

  if (!message || !EXTENSION_MESSAGES.has(message.type)) {
    return false;
  }

  sendToActiveTab(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || "Unable to reach this page. Try reloading it, then open the extension again."
      });
    });

  return true;
});

chrome.action.onClicked.addListener(async () => {
  await sendToActiveTab({ type: "annotator:toggle-toolbar" }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  resumeReferencePicker(tabId).catch(() => {});
});

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const guardedUrl = tab.url || "";
  if (/^(chrome|edge|about|devtools):\/\//.test(guardedUrl)) {
    throw new Error("Chrome does not allow extensions to annotate this internal browser page.");
  }

  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

async function captureVisibleTab(sender) {
  const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return { ok: true, dataUrl };
}

async function rememberReferencePickerTab(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { ok: false, error: "No source tab found." };
  }

  const stored = await chrome.storage.local.get(REFERENCE_PICKER_KEY);
  const picker = stored[REFERENCE_PICKER_KEY];
  if (picker?.id) {
    await chrome.storage.local.set({
      [REFERENCE_PICKER_KEY]: {
        ...picker,
        tabId
      }
    });
  }

  return { ok: true };
}

async function resumeReferencePicker(tabId) {
  const stored = await chrome.storage.local.get(REFERENCE_PICKER_KEY);
  const picker = stored[REFERENCE_PICKER_KEY];
  if (!picker?.id || picker.tabId !== tabId) {
    return;
  }

  await ensureContentScript(tabId);
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "annotator:ping" });
    if (response?.ok) {
      return;
    }
  } catch (_error) {
    // Content scripts declared in the manifest only attach after a page load.
  }

  await chrome.scripting.insertCSS({ target: { tabId }, files: ["contentStyles.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["contentScript.js"] });
}

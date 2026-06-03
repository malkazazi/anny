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
  if (!message || !EXTENSION_MESSAGES.has(message.type)) {
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

(() => {
  if (window.__localUiAnnotatorLoaded) {
    return;
  }

  window.__localUiAnnotatorLoaded = true;

  const PAGE_PREFIX = "anny:page:";
  const SETTINGS_KEY = "anny:settings";
  const MAX_TEXT = 700;
  const SHOT_MAX_WIDTH = 480;
  const SHOT_MAX_BYTES = 150 * 1024;
  const STABLE_DATA_ATTRIBUTES = [
    "data-testid",
    "data-test",
    "data-test-id",
    "data-cy",
    "data-qa",
    "data-component",
    "data-component-id",
    "data-name",
    "data-role"
  ];

  const defaultSettings = {
    markersVisible: true,
    animationsPaused: false
  };

  const state = {
    annotations: [],
    feedbackEnabled: false,
    toolbarVisible: false,
    markersVisible: true,
    animationsPaused: false,
    baseHash: "",
    baseCapturedAt: "",
    referencePicker: null,
    url: location.href
  };

  const dom = {
    hoverRing: null,
    targetRing: null,
    composer: null,
    toolbar: null,
    toast: null
  };

  let currentPageKey = pageKey();
  let hoveredElement = null;
  let lastSelection = null;
  const mediaPausedByAnnotator = new Set();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "annotator:ping") {
      sendResponse({ ok: true });
      return false;
    }

    handleRuntimeMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "Annotation command failed." }));

    return true;
  });

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("selectionchange", rememberSelection);
  window.addEventListener("scroll", syncHoverRing, true);
  window.addEventListener("resize", syncHoverRing);

  init();

  async function init() {
    await loadStateForPage();
    renderToolbar();
    renderMarkers();
    applyPausedState();
    watchUrlChanges();
  }

  async function handleRuntimeMessage(message) {
    if (!message?.type) {
      return ok();
    }

    if (message.type === "annotator:get-state") {
      return ok();
    }

    if (message.type === "annotator:open-toolbar") {
      state.toolbarVisible = true;
      state.feedbackEnabled = true;
      closeComposer();
      renderToolbar();
      syncHoverRing();
      return ok();
    }

    if (message.type === "annotator:toggle-toolbar") {
      if (state.toolbarVisible) {
        closeToolbar();
      } else {
        state.toolbarVisible = true;
        state.feedbackEnabled = true;
        closeComposer();
        renderToolbar();
        syncHoverRing();
      }
      return ok();
    }

    if (message.type === "annotator:toggle-feedback") {
      state.toolbarVisible = true;
      state.feedbackEnabled = !state.feedbackEnabled;
      closeComposer();
      renderToolbar();
      syncHoverRing();
      toast(state.feedbackEnabled ? "Feedback mode on. Click an element." : "Feedback mode off.");
      return ok();
    }

    if (message.type === "annotator:set-feedback") {
      state.feedbackEnabled = Boolean(message.enabled);
      state.toolbarVisible = state.toolbarVisible || state.feedbackEnabled;
      closeComposer();
      renderToolbar();
      syncHoverRing();
      return ok();
    }

    if (message.type === "annotator:toggle-markers") {
      state.markersVisible = !state.markersVisible;
      await saveSettings();
      renderToolbar();
      renderMarkers();
      return ok();
    }

    if (message.type === "annotator:toggle-pause") {
      state.animationsPaused = !state.animationsPaused;
      await saveSettings();
      applyPausedState();
      renderToolbar();
      toast(state.animationsPaused ? "Page motion paused." : "Page motion resumed.");
      return ok();
    }

    if (message.type === "annotator:clear") {
      clearPageFeedback();
      await saveAnnotations();
      closeComposer();
      renderMarkers();
      renderToolbar();
      return ok();
    }

    if (message.type === "annotator:export") {
      if (state.annotations.length) {
        ensureBaseCapture();
        await saveAnnotations();
      }
      return {
        ok: true,
        state: publicState(),
        markdown: formatMarkdown(state.annotations)
      };
    }

    return ok();
  }

  function ok() {
    return { ok: true, state: publicState() };
  }

  function publicState() {
    return {
      annotations: state.annotations,
      feedbackEnabled: state.feedbackEnabled,
      toolbarVisible: state.toolbarVisible,
      markersVisible: state.markersVisible,
      animationsPaused: state.animationsPaused,
      baseHash: state.baseHash,
      baseCapturedAt: state.baseCapturedAt,
      url: location.href,
      title: document.title
    };
  }

  async function loadStateForPage() {
    currentPageKey = pageKey();
    const stored = await storageGet([currentPageKey, SETTINGS_KEY]);
    const page = stored[currentPageKey] || {};
    const settings = { ...defaultSettings, ...(stored[SETTINGS_KEY] || {}) };

    state.annotations = Array.isArray(page.annotations) ? page.annotations.map(stripRemovedAnnotationFields) : [];
    state.markersVisible = settings.markersVisible;
    state.animationsPaused = settings.animationsPaused;
    state.baseHash = typeof page.baseHash === "string" ? page.baseHash : "";
    state.baseCapturedAt = typeof page.baseCapturedAt === "string" ? page.baseCapturedAt : "";
    state.url = location.href;
  }

  async function saveAnnotations() {
    await storageSet({
      [currentPageKey]: {
        url: location.href,
        title: document.title,
        updatedAt: new Date().toISOString(),
        baseHash: state.baseHash,
        baseCapturedAt: state.baseCapturedAt,
        annotations: state.annotations
      }
    });
  }

  function saveSettings() {
    return storageSet({
      [SETTINGS_KEY]: {
        markersVisible: state.markersVisible,
        animationsPaused: state.animationsPaused
      }
    });
  }

  function stripRemovedAnnotationFields(annotation) {
    const kept = { ...(annotation || {}) };
    delete kept["des" + "ired"];
    delete kept["gr" + "oup"];
    return kept;
  }

  function onMouseMove(event) {
    if (!state.feedbackEnabled || isAnnotatorElement(event.target)) {
      return;
    }

    const target = elementAt(event.clientX, event.clientY);
    if (!target || target === document.documentElement || target === document.body) {
      hideHoverRing();
      return;
    }

    hoveredElement = target;
    showHoverRing(target);
  }

  function onDocumentClick(event) {
    if (isAnnotatorElement(event.target)) {
      return;
    }

    if (state.referencePicker) {
      const target = elementAt(event.clientX, event.clientY);
      if (!target || target === document.documentElement) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const selector = getRobustSelectorInfo(target).selector;
      state.referencePicker.input.value = selector;
      state.referencePicker = null;
      toast("Reference captured.");
      return;
    }

    if (!state.feedbackEnabled) {
      return;
    }

    const target = elementAt(event.clientX, event.clientY);
    if (!target || target === document.documentElement) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    hoveredElement = target;
    showComposer(target, event.clientX, event.clientY);
  }

  function onKeyDown(event) {
    if (!state.toolbarVisible) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === "escape") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeToolbar();
      return;
    }

    if (isTypingTarget(event.target)) {
      return;
    }

    const modifier = event.metaKey || event.ctrlKey;

    if (modifier && event.shiftKey && key === "f") {
      event.preventDefault();
      state.feedbackEnabled = !state.feedbackEnabled;
      closeComposer();
      renderToolbar();
      syncHoverRing();
      toast(state.feedbackEnabled ? "Feedback mode on. Click an element." : "Feedback mode off.");
      return;
    }

    if (key === "h") {
      event.preventDefault();
      state.markersVisible = !state.markersVisible;
      saveSettings();
      renderToolbar();
      renderMarkers();
      return;
    }

    if (key === "p") {
      event.preventDefault();
      state.animationsPaused = !state.animationsPaused;
      saveSettings();
      applyPausedState();
      renderToolbar();
      return;
    }

    if (key === "c") {
      event.preventDefault();
      copyFromPage();
      return;
    }

    if (key === "x") {
      event.preventDefault();
      clearPageFeedback();
      saveAnnotations();
      renderMarkers();
      renderToolbar();
      toast("Cleared annotations for this page.");
    }
  }

  function rememberSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text) {
      return;
    }

    lastSelection = {
      text: truncate(text, 500),
      anchorPath: selection.anchorNode ? getNodePath(selection.anchorNode) : "",
      focusPath: selection.focusNode ? getNodePath(selection.focusNode) : ""
    };
  }

  function showHoverRing(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideHoverRing();
      return;
    }

    if (!dom.hoverRing) {
      dom.hoverRing = document.createElement("div");
      dom.hoverRing.className = "local-annotator-hover-ring";
      document.documentElement.appendChild(dom.hoverRing);
    }

    Object.assign(dom.hoverRing.style, {
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${Math.max(1, rect.height)}px`
    });

    dom.hoverRing.dataset.label = elementLabel(element);
  }

  function syncHoverRing() {
    if (!state.feedbackEnabled || !hoveredElement) {
      hideHoverRing();
      return;
    }

    showHoverRing(hoveredElement);
  }

  function hideHoverRing() {
    dom.hoverRing?.remove();
    dom.hoverRing = null;
  }

  function showTargetRing(element) {
    const rect = element.getBoundingClientRect();
    if (!dom.targetRing) {
      dom.targetRing = document.createElement("div");
      dom.targetRing.className = "local-annotator-target-ring";
      document.documentElement.appendChild(dom.targetRing);
    }

    Object.assign(dom.targetRing.style, {
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${Math.max(1, rect.height)}px`
    });
  }

  function hideTargetRing() {
    dom.targetRing?.remove();
    dom.targetRing = null;
  }

  async function showComposer(element, clientX, clientY, existingAnnotation = null) {
    closeComposer();

    const snapshot = existingAnnotation || collectElementContext(element, clientX, clientY);
    if (!existingAnnotation) {
      snapshot.shot = await captureElementShot(snapshot);
    }

    showTargetRing(element);

    const composer = document.createElement("form");
    composer.className = "local-annotator-composer";
    composer.innerHTML = `
      <strong title="${escapeAttr(snapshot.elementPath)}">${escapeHtml(snapshot.elementSummary)}</strong>
      <textarea name="comment" placeholder="Describe the change you want the agent to make..." required>${escapeHtml(snapshot.comment || "")}</textarea>
      <label>
        <span>Scope</span>
        <select name="scope">
          ${scopeOptions(snapshot.scope || "element")}
        </select>
      </label>
      <label>
        <span>Reference</span>
        <div class="local-annotator-reference-row">
          <input name="reference" value="${escapeAttr(snapshot.reference || "")}" placeholder="Selector, file path, or attached image">
          <button type="button" data-pick-reference="true" aria-label="Pick reference element" title="Pick">${lucideIcon("mouse-pointer-2")}<span>Pick</span></button>
        </div>
      </label>
      <details>
        <summary>Element context</summary>
        <pre>${escapeHtml(composeContextPreview(snapshot))}</pre>
      </details>
      <div class="local-annotator-actions">
        ${existingAnnotation ? '<button type="button" data-delete="true">Delete</button>' : ""}
        <button type="button" data-cancel="true">Cancel</button>
        <button type="submit" data-primary="true">${existingAnnotation ? "Update" : "Add"}</button>
      </div>
    `;

    document.documentElement.appendChild(composer);
    dom.composer = composer;
    placeComposer(composer, clientX, clientY);

    const textarea = composer.querySelector("textarea");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      event.preventDefault();
      composer.requestSubmit();
    });

    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(composer);
      const comment = String(formData.get("comment") || "").trim();
      if (!comment) {
        textarea.focus();
        return;
      }

      const nextAnnotation = {
        ...snapshot,
        comment,
        scope: normalizeScope(formData.get("scope")),
        reference: normalizeWhitespace(formData.get("reference")),
        updatedAt: new Date().toISOString()
      };

      if (existingAnnotation) {
        state.annotations = state.annotations.map((annotation) =>
          annotation.id === existingAnnotation.id ? nextAnnotation : annotation
        );
      } else {
        state.annotations.push(nextAnnotation);
      }

      ensureBaseCapture();
      await saveAnnotations();
      closeComposer();
      renderMarkers();
      renderToolbar();
      toast(existingAnnotation ? "Annotation updated." : "Annotation added.");
    });

    composer.querySelector("[data-cancel]")?.addEventListener("click", closeComposer);
    composer.querySelector("[data-pick-reference]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.referencePicker = {
        input: composer.querySelector('input[name="reference"]')
      };
      toast("Click the element to match.");
    });
    composer.querySelector("[data-delete]")?.addEventListener("click", async () => {
      state.annotations = state.annotations.filter((annotation) => annotation.id !== existingAnnotation.id);
      await saveAnnotations();
      closeComposer();
      renderMarkers();
      renderToolbar();
      toast("Annotation deleted.");
    });
  }

  function placeComposer(composer, clientX, clientY) {
    const margin = 12;
    const rect = composer.getBoundingClientRect();
    const left = clamp(clientX + 14, margin, window.innerWidth - rect.width - margin);
    const top = clamp(clientY + 14, margin, window.innerHeight - rect.height - margin);

    composer.style.left = `${left}px`;
    composer.style.top = `${top}px`;
  }

  function closeComposer() {
    state.referencePicker = null;
    dom.composer?.remove();
    dom.composer = null;
    hideTargetRing();
  }

  function closeToolbar() {
    state.toolbarVisible = false;
    state.feedbackEnabled = false;
    closeComposer();
    hideHoverRing();
    renderToolbar();
  }

  function renderMarkers() {
    document.querySelectorAll(".local-annotator-marker").forEach((node) => node.remove());

    if (!state.markersVisible) {
      return;
    }

    state.annotations.forEach((annotation, index) => {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "local-annotator-marker";
      marker.textContent = String(index + 1);
      marker.dataset.comment = annotation.comment || "Annotation";
      marker.title = `${annotation.elementSummary}\n${annotation.comment}`;
      marker.style.left = `${annotation.marker.x}px`;
      marker.style.top = `${annotation.marker.y}px`;

      marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const element = safeQuery(annotation.elementPath) || safeQuery(annotation.fullPath) || document.body;
        showComposer(element, event.clientX, event.clientY, annotation);
      });

      marker.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.annotations = state.annotations.filter((item) => item.id !== annotation.id);
        await saveAnnotations();
        renderMarkers();
        renderToolbar();
        toast("Annotation deleted.");
      });

      document.documentElement.appendChild(marker);
    });
  }

  function renderToolbar() {
    if (!state.toolbarVisible) {
      dom.toolbar?.remove();
      dom.toolbar = null;
      return;
    }

    if (!dom.toolbar) {
      dom.toolbar = document.createElement("div");
      dom.toolbar.className = "local-annotator-toolbar";
      dom.toolbar.innerHTML = `
        <button type="button" data-action="feedback" aria-label="Toggle feedback mode" data-tooltip="Annotate">${lucideIcon("crosshair")}</button>
        <button type="button" data-action="markers" aria-label="Show or hide markers" data-tooltip="Markers">${lucideIcon("eye")}</button>
        <button type="button" data-action="pause" aria-label="Pause animations and media" data-tooltip="Pause motion">${lucideIcon("pause")}</button>
        <button type="button" data-action="copy" aria-label="Copy annotations" data-tooltip="Copy">${lucideIcon("copy")}</button>
        <button type="button" data-action="clear" aria-label="Clear annotations" data-tooltip="Clear">${lucideIcon("trash-2")}</button>
        <button type="button" data-action="close" aria-label="Close annotator toolbar" data-tooltip="Close">${lucideIcon("x")}</button>
        <span data-count>0</span>
      `;
      document.documentElement.appendChild(dom.toolbar);

      dom.toolbar.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (button.dataset.action === "close") {
          closeToolbar();
          return;
        }

        if (button.dataset.action === "feedback") {
          state.toolbarVisible = true;
          state.feedbackEnabled = !state.feedbackEnabled;
          closeComposer();
          syncHoverRing();
          toast(state.feedbackEnabled ? "Feedback mode on. Click an element." : "Feedback mode off.");
        }

        if (button.dataset.action === "markers") {
          state.markersVisible = !state.markersVisible;
          await saveSettings();
          renderMarkers();
        }

        if (button.dataset.action === "pause") {
          state.animationsPaused = !state.animationsPaused;
          await saveSettings();
          applyPausedState();
        }

        if (button.dataset.action === "copy") {
          await copyFromPage();
        }

        if (button.dataset.action === "clear") {
          clearPageFeedback();
          await saveAnnotations();
          renderMarkers();
          closeComposer();
          toast("Cleared annotations for this page.");
        }

        renderToolbar();
      });
    }

    const feedback = dom.toolbar.querySelector('[data-action="feedback"]');
    const markers = dom.toolbar.querySelector('[data-action="markers"]');
    const pause = dom.toolbar.querySelector('[data-action="pause"]');
    const count = dom.toolbar.querySelector("[data-count]");

    feedback.classList.toggle("is-active", state.feedbackEnabled);
    markers.classList.toggle("is-active", state.markersVisible);
    pause.classList.toggle("is-active", state.animationsPaused);
    count.textContent = String(state.annotations.length);
  }

  async function copyFromPage() {
    if (!state.annotations.length) {
      toast("No annotations to copy.");
      return;
    }

    ensureBaseCapture();
    await saveAnnotations();
    const markdown = formatMarkdown(state.annotations);
    const copied = await writeClipboard(markdown, state.annotations);
    toast(copied ? `Copied ${state.annotations.length} annotation${state.annotations.length === 1 ? "" : "s"}.` : "Copy failed. Check clipboard permission and try again.");
  }

  function collectElementContext(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    const selectorInfo = getRobustSelectorInfo(element);
    const selector = selectorInfo.selector;
    const fullPath = getFullPath(element);
    const react = detectReact(element);
    const attrs = relevantAttributes(element);
    const markerX = Math.round(window.scrollX + rect.left + Math.min(rect.width - 14, 10));
    const markerY = Math.round(window.scrollY + rect.top + Math.min(rect.height - 14, 10));

    return {
      id: `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      comment: "",
      scope: "element",
      reference: "",
      elementPath: selector,
      robustSelector: selector,
      selectorStrategy: selectorInfo.strategy,
      selectorIsPositional: selectorInfo.positional,
      fullPath,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      x: round((clientX / Math.max(1, window.innerWidth)) * 100, 2),
      y: round(window.scrollY + clientY, 1),
      element: element.tagName.toLowerCase(),
      elementSummary: elementLabel(element),
      cssClasses: classList(element),
      attributes: attrs,
      accessibility: accessibilitySummary(element),
      roleAria: roleAriaSummary(element),
      humanLocator: humanLocator(element),
      nearbyText: nearbyText(element),
      selectedText: selectionForElement(element),
      nearbyElements: nearbyElements(element),
      boundingBox: {
        x: round(window.scrollX + rect.left, 1),
        y: round(window.scrollY + rect.top, 1),
        width: round(rect.width, 1),
        height: round(rect.height, 1),
        viewportX: round(rect.left, 1),
        viewportY: round(rect.top, 1)
      },
      marker: {
        x: markerX,
        y: markerY
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: round(window.scrollX, 1),
        scrollY: round(window.scrollY, 1),
        devicePixelRatio: window.devicePixelRatio
      },
      isFixed: ["fixed", "sticky"].includes(styles.position),
      reactComponents: react.components,
      source: react.source
    };
  }

  function formatMarkdown(annotations) {
    return formatAgentMarkdown(annotations);
  }

  function formatAgentMarkdown(annotations) {
    if (!annotations.length) {
      return "";
    }

    const title = document.title || "Untitled page";
    const url = location.href;
    const baseHash = state.baseHash || domSnapshotHash();
    const baseCapturedAt = state.baseCapturedAt || new Date().toISOString();
    const lines = [
      "Apply and implement these changes to the things mentioned below. Read every annotation in this export, find the referenced UI or code, and make the requested changes. Unless the apply line names a subset, apply every annotation in the batch.",
      "",
      `# UI Feedback — ${title}`
    ];

    lines.push(agentLine("source", url));
    lines.push(agentLine("apply", `all ${annotations.length} annotation${annotations.length === 1 ? "" : "s"} in this batch`));
    lines.push(agentLine("base", `${baseHash} (captured ${baseCapturedAt})`));
    lines.push("# base = hash of the DOM these notes were taken against; if it no longer matches, some items may already be applied.");

    const attachments = formatAttachments(annotations);
    if (attachments) {
      lines.push(agentLine("attachments", attachments));
    }

    lines.push("");

    annotations.forEach((annotation, index) => {
      lines.push(`### ${index + 1}  ·  id: ${annotation.id}`);
      lines.push(agentLine("intent", annotation.comment || ""));
      lines.push(agentLine("target", `${annotation.humanLocator || humanLocatorFromAnnotation(annotation)}   ·   anchor: ${anchorForAnnotation(annotation)}`));

      const text = truncate(annotation.selectedText || annotation.nearbyText || "", 80);
      if (text) {
        lines.push(agentLine("text", text));
      }

      const roleAria = annotation.roleAria || roleAriaFromAccessibility(annotation.accessibility);
      if (roleAria) {
        lines.push(agentLine("role/aria", roleAria));
      }

      lines.push(agentLine("scope", normalizeScope(annotation.scope)));

      if (annotation.reference) {
        lines.push(agentLine("reference", annotation.reference));
      }
      lines.push(agentLine("shot", shotNote(annotation)));
      lines.push("");
    });

    lines.push("Implementation note: use the fields above as implementation context. Do not skip annotations because their screenshot is missing; the shot field only describes attachment availability.");

    return lines.join("\n").trim() + "\n";
  }

  function agentLine(label, value) {
    const text = String(value || "");
    const key = `${label}:`.padEnd(11, " ");
    const [first, ...rest] = text.split(/\r?\n/);
    if (!rest.length) {
      return `${key}${first}`;
    }

    return [`${key}${first}`, ...rest.map((line) => `${" ".repeat(11)}${line}`)].join("\n");
  }

  function formatAttachments(annotations) {
    const attached = [];
    const missing = [];

    annotations.forEach((annotation, index) => {
      if (annotation.shot?.dataUrl) {
        attached.push(`#${index + 1}`);
        return;
      }

      missing.push(`#${index + 1}`);
    });

    const attachedText = attached.length ? formatAnnotationList(attached) : "none";
    const missingText = missing.length
      ? `${formatAnnotationList(missing)} ${missing.length === 1 ? "has" : "have"} no image crop${missing.length === 1 ? "" : "s"} but must still be applied`
      : "every annotation has an image crop";

    return `${attachedText} (image crops; ${missingText})`;
  }

  function formatAnnotationList(items) {
    return items.join(", ");
  }

  function shotNote(annotation) {
    if (annotation.shot?.note) {
      return annotation.shot.note;
    }

    if (annotation.shot?.dataUrl) {
      return "attached image crop";
    }

    return "screenshot unavailable; no image crop captured";
  }

  function anchorForAnnotation(annotation) {
    const selector = annotation.robustSelector || annotation.elementPath || "";
    const positional = annotation.selectorIsPositional || annotation.selectorStrategy === "positional" || selector.includes(":nth-of-type");
    return positional ? `${selector} (positional — may drift)` : selector;
  }

  function roleAriaFromAccessibility(accessibility) {
    if (!accessibility) {
      return "";
    }

    return String(accessibility)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.startsWith("role=") || item.startsWith("aria-label=") || item.startsWith("aria-labelledby="))
      .join(", ");
  }

  function clearPageFeedback() {
    state.annotations = [];
    state.baseHash = "";
    state.baseCapturedAt = "";
  }

  function ensureBaseCapture() {
    if (!state.annotations.length || state.baseHash) {
      return;
    }

    state.baseHash = domSnapshotHash();
    state.baseCapturedAt = new Date().toISOString();
  }

  function domSnapshotHash() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll(".local-annotator-hover-ring, .local-annotator-target-ring, .local-annotator-marker, .local-annotator-composer, .local-annotator-toast, .local-annotator-toolbar").forEach((node) => node.remove());
    return djb2Hash(clone.outerHTML);
  }

  function djb2Hash(value) {
    let hash = 5381;
    const text = String(value || "");

    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
    }

    return hash.toString(16).padStart(8, "0").slice(0, 12);
  }

  async function captureElementShot(annotation) {
    if (!annotation.boundingBox?.width || !annotation.boundingBox?.height) {
      return null;
    }

    const visibleRect = visibleCropRect(annotation.boundingBox);
    if (!visibleRect) {
      return { note: "screenshot skipped; target was outside the visible viewport" };
    }

    try {
      return await withHiddenAnnotatorOverlays(async () => {
        const dataUrl = await requestVisibleTabImage();
        const image = await loadImage(dataUrl);
        const shot = await cropImageToShot(image, visibleRect);
        return shot || { note: "screenshot skipped; crop exceeded size cap" };
      });
    } catch (_error) {
      return { note: "screenshot unavailable; capture permission failed" };
    }
  }

  function visibleCropRect(box) {
    const left = clamp(box.viewportX, 0, window.innerWidth);
    const top = clamp(box.viewportY, 0, window.innerHeight);
    const right = clamp(box.viewportX + box.width, 0, window.innerWidth);
    const bottom = clamp(box.viewportY + box.height, 0, window.innerHeight);

    if (right - left < 2 || bottom - top < 2) {
      return null;
    }

    return { left, top, width: right - left, height: bottom - top };
  }

  async function withHiddenAnnotatorOverlays(callback) {
    const nodes = Array.from(document.querySelectorAll(".local-annotator-hover-ring, .local-annotator-target-ring, .local-annotator-marker, .local-annotator-composer, .local-annotator-toast, .local-annotator-toolbar"));
    const previous = nodes.map((node) => [node, node.style.visibility]);

    nodes.forEach((node) => {
      node.style.visibility = "hidden";
    });

    await nextFrame();

    try {
      return await callback();
    } finally {
      previous.forEach(([node, visibility]) => {
        node.style.visibility = visibility;
      });
    }
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function requestVisibleTabImage() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "annotator:capture-visible-tab" }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }

        if (!response?.ok || !response.dataUrl) {
          reject(new Error(response?.error || "Unable to capture visible tab."));
          return;
        }

        resolve(response.dataUrl);
      });
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  async function cropImageToShot(image, crop) {
    const dpr = window.devicePixelRatio || 1;
    let width = Math.min(SHOT_MAX_WIDTH, Math.round(crop.width));
    let height = Math.max(1, Math.round((crop.height / Math.max(1, crop.width)) * width));

    while (width >= 80) {
      const dataUrl = renderCrop(image, crop, dpr, width, height);
      const bytes = dataUrlBytes(dataUrl);
      if (bytes <= SHOT_MAX_BYTES) {
        return {
          note: `attached image crop (${Math.round(bytes / 1024)} KB)`,
          dataUrl,
          width,
          height,
          bytes
        };
      }

      width = Math.floor(width * 0.75);
      height = Math.max(1, Math.floor(height * 0.75));
    }

    return null;
  }

  function renderCrop(image, crop, dpr, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    context.drawImage(
      image,
      Math.round(crop.left * dpr),
      Math.round(crop.top * dpr),
      Math.round(crop.width * dpr),
      Math.round(crop.height * dpr),
      0,
      0,
      width,
      height
    );

    return canvas.toDataURL("image/png");
  }

  function dataUrlBytes(dataUrl) {
    const base64 = String(dataUrl).split(",")[1] || "";
    return Math.ceil((base64.length * 3) / 4);
  }

  function applyPausedState() {
    document.documentElement.classList.toggle("local-annotator-paused", state.animationsPaused);

    if (state.animationsPaused) {
      document.querySelectorAll("video, audio").forEach((media) => {
        if (!media.paused) {
          media.pause();
          mediaPausedByAnnotator.add(media);
        }
      });
      return;
    }

    mediaPausedByAnnotator.forEach((media) => {
      media.play?.().catch(() => {});
    });
    mediaPausedByAnnotator.clear();
  }

  function watchUrlChanges() {
    let lastHref = location.href;
    window.setInterval(async () => {
      if (location.href === lastHref) {
        return;
      }

      lastHref = location.href;
      await loadStateForPage();
      closeComposer();
      hideHoverRing();
      renderMarkers();
      renderToolbar();
    }, 700);
  }

  function getBestSelector(element) {
    return getRobustSelectorInfo(element).selector;
  }

  function getRobustSelectorInfo(element) {
    if (!(element instanceof Element)) {
      return { selector: "", strategy: "none", positional: false };
    }

    const tag = element.tagName.toLowerCase();
    if (element.id && isHumanToken(element.id)) {
      const selector = `${tag}#${cssEscape(element.id)}`;
      if (isUnique(selector)) {
        return { selector, strategy: "id", positional: false };
      }
    }

    const stableAttr = firstAttribute(element, STABLE_DATA_ATTRIBUTES);
    if (stableAttr && isHumanToken(stableAttr.value)) {
      const selector = `${tag}[${stableAttr.name}="${cssString(stableAttr.value)}"]`;
      if (isUnique(selector)) {
        return { selector, strategy: "data", positional: false };
      }
    }

    const semanticClass = semanticClassName(element);
    if (semanticClass) {
      const selector = `${tag}.${cssEscape(semanticClass)}`;
      if (isUnique(selector)) {
        return { selector, strategy: "class", positional: false };
      }
    }

    const text = exactShortVisibleText(element);
    if (text && isUniqueTextLocator(tag, text, element)) {
      return { selector: `${tag}:has-text("${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`, strategy: "text", positional: false };
    }

    return { selector: getPositionalSelector(element), strategy: "positional", positional: true };
  }

  function getPositionalSelector(element) {
    const segments = [];
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const segment = selectorSegment(node);
      segments.unshift(segment);

      const selector = segments.join(" > ");
      if (isUnique(selector)) {
        return selector;
      }

      node = node.parentElement;
    }

    return segments.join(" > ") || element.tagName.toLowerCase();
  }

  function selectorSegment(element) {
    const tag = element.tagName.toLowerCase();
    const testId = firstAttribute(element, ["data-testid", "data-test-id", "data-cy", "data-qa"]);
    if (testId) {
      return `${tag}[${testId.name}="${cssString(testId.value)}"]`;
    }

    if (element.id) {
      return `${tag}#${cssEscape(element.id)}`;
    }

    const classes = Array.from(element.classList || [])
      .filter((name) => !name.startsWith("local-annotator"))
      .filter((name) => /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name))
      .slice(0, 3);

    let segment = tag + classes.map((name) => `.${cssEscape(name)}`).join("");
    const parent = element.parentElement;
    if (!parent) {
      return segment;
    }

    const sameTag = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    if (sameTag.length > 1) {
      segment += `:nth-of-type(${sameTag.indexOf(element) + 1})`;
    }

    return segment;
  }

  function getFullPath(element) {
    const segments = [];
    let node = element;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node === document.documentElement) {
        segments.unshift("html");
        break;
      }
      segments.unshift(selectorSegment(node));
      node = node.parentElement;
    }

    return segments.join(" > ");
  }

  function getNodePath(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element ? getBestSelector(element) : "";
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (_error) {
      return false;
    }
  }

  function safeQuery(selector) {
    try {
      if (!selector) {
        return null;
      }

      const textLocator = parseTextLocator(selector);
      if (textLocator) {
        return findByTextLocator(textLocator.tag, textLocator.text);
      }

      return document.querySelector(selector);
    } catch (_error) {
      return null;
    }
  }

  function elementAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    if (!element || isAnnotatorElement(element)) {
      return null;
    }

    return element;
  }

  function elementLabel(element) {
    const tag = element.tagName.toLowerCase();
    const text = directText(element);
    const role = element.getAttribute("role");
    const aria = element.getAttribute("aria-label");
    const id = element.id ? `#${element.id}` : "";
    const classes = classList(element)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("");
    const name = aria || text || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("name") || "";

    return `${tag}${id}${classes}${role ? `[role="${role}"]` : ""}${name ? ` "${truncate(name, 70)}"` : ""}`;
  }

  function directText(element) {
    const text = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(" ");
    return normalizeWhitespace(text || element.innerText || element.textContent || "");
  }

  function nearbyText(element) {
    const ownText = normalizeWhitespace(element.innerText || element.textContent || "");
    if (ownText) {
      return truncate(ownText, MAX_TEXT);
    }

    const parentText = normalizeWhitespace(element.parentElement?.innerText || "");
    return truncate(parentText, MAX_TEXT);
  }

  function nearbyElements(element) {
    const parent = element.parentElement;
    if (!parent) {
      return "";
    }

    const siblings = Array.from(parent.children);
    const index = siblings.indexOf(element);
    const nearby = siblings
      .slice(Math.max(0, index - 2), Math.min(siblings.length, index + 3))
      .map((sibling, siblingIndex) => {
        const actualIndex = Math.max(0, index - 2) + siblingIndex;
        const prefix = sibling === element ? "target" : actualIndex < index ? "before" : "after";
        return `${prefix}: ${elementLabel(sibling)} | ${getBestSelector(sibling)}`;
      });

    return [`parent: ${elementLabel(parent)} | ${getBestSelector(parent)}`, ...nearby].join("\n");
  }

  function selectionForElement(element) {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    const anchorElement =
      selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement;

    if (text && anchorElement && (element === anchorElement || element.contains(anchorElement))) {
      return truncate(text, 500);
    }

    return lastSelection?.text || "";
  }

  function accessibilitySummary(element) {
    const values = [];
    const role = element.getAttribute("role");
    const ariaLabel = element.getAttribute("aria-label");
    const ariaLabelledBy = element.getAttribute("aria-labelledby");
    const ariaDescribedBy = element.getAttribute("aria-describedby");
    const disabled = element.getAttribute("aria-disabled") || element.disabled;
    const label = labelFor(element);

    if (role) values.push(`role=${role}`);
    if (ariaLabel) values.push(`aria-label="${ariaLabel}"`);
    if (ariaLabelledBy) values.push(`aria-labelledby="${ariaLabelledBy}"`);
    if (ariaDescribedBy) values.push(`aria-describedby="${ariaDescribedBy}"`);
    if (label) values.push(`label="${label}"`);
    if (disabled) values.push("disabled=true");

    return values.join(", ");
  }

  function roleAriaSummary(element) {
    const values = [];
    const role = element.getAttribute("role");
    const ariaLabel = element.getAttribute("aria-label");
    const ariaLabelledBy = element.getAttribute("aria-labelledby");

    if (role) values.push(`role=${role}`);
    if (ariaLabel) values.push(`aria-label="${truncate(ariaLabel, 80)}"`);
    if (ariaLabelledBy) {
      const label = labelledByText(ariaLabelledBy);
      values.push(label ? `aria-labelledby="${truncate(label, 80)}"` : `aria-labelledby="${ariaLabelledBy}"`);
    }

    return values.join(", ");
  }

  function labelFor(element) {
    if (element.id) {
      const explicit = document.querySelector(`label[for="${cssString(element.id)}"]`);
      if (explicit) {
        return normalizeWhitespace(explicit.innerText || explicit.textContent || "");
      }
    }

    const implicit = element.closest("label");
    return implicit ? normalizeWhitespace(implicit.innerText || implicit.textContent || "") : "";
  }

  function relevantAttributes(element) {
    return Array.from(element.attributes || [])
      .filter((attr) => {
        return (
          ["id", "class", "href", "src", "alt", "title", "name", "type", "role", "placeholder", "value"].includes(attr.name) ||
          attr.name.startsWith("aria-") ||
          attr.name.startsWith("data-")
        );
      })
      .map((attr) => ({ name: attr.name, value: truncate(attr.value, 240) }));
  }

  function classList(element) {
    if (typeof element.className === "string") {
      return element.className
        .split(/\s+/)
        .filter((name) => name && !name.startsWith("local-annotator"))
        .join(" ");
    }

    return Array.from(element.classList || [])
      .filter((name) => !name.startsWith("local-annotator"))
      .join(" ");
  }

  function humanLocator(element) {
    const section = closestSectionLabel(element);
    const own = ownHumanLabel(element);

    if (section && own && !sameText(section, own)) {
      return `${section} · ${own}`;
    }

    return own || section || elementLabel(element);
  }

  function humanLocatorFromAnnotation(annotation) {
    const summary = annotation.elementSummary || annotation.element || "element";
    const text = truncate(annotation.selectedText || annotation.nearbyText || "", 64);
    return text ? `${summary} · "${text}"` : summary;
  }

  function closestSectionLabel(element) {
    let cursor = element.parentElement;

    while (cursor && cursor !== document.documentElement) {
      const aria = cursor.getAttribute("aria-label");
      if (aria) {
        return truncate(aria, 72);
      }

      const labelledBy = cursor.getAttribute("aria-labelledby");
      if (labelledBy) {
        const label = labelledByText(labelledBy);
        if (label) {
          return truncate(label, 72);
        }
      }

      if (isSectionLike(cursor)) {
        const heading = headingTextFor(cursor, element);
        if (heading) {
          return truncate(heading, 72);
        }
      }

      cursor = cursor.parentElement;
    }

    return nearestPrecedingHeading(element);
  }

  function isSectionLike(element) {
    return ["SECTION", "ARTICLE", "MAIN", "ASIDE", "NAV", "FORM", "HEADER", "FOOTER"].includes(element.tagName) || ["region", "main", "navigation", "form", "banner", "contentinfo"].includes(element.getAttribute("role") || "");
  }

  function headingTextFor(container, target) {
    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"));
    const heading = headings.find((item) => item !== target && !target.contains(item) && (item.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
    return heading ? normalizeWhitespace(heading.innerText || heading.textContent || "") : "";
  }

  function nearestPrecedingHeading(element) {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"));
    let best = "";

    for (const heading of headings) {
      if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
        best = normalizeWhitespace(heading.innerText || heading.textContent || "");
      }
    }

    return truncate(best, 72);
  }

  function labelledByText(value) {
    return value
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((element) => normalizeWhitespace(element.innerText || element.textContent || ""))
      .filter(Boolean)
      .join(" ");
  }

  function ownHumanLabel(element) {
    const text = truncate(
      element.getAttribute("aria-label") ||
        directText(element) ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        "",
      64
    );
    const noun = elementNoun(element);

    return text ? `the "${text}" ${noun}` : `the ${noun}`;
  }

  function elementNoun(element) {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");

    if (role) return role;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (["input", "textarea", "select"].includes(tag)) return "field";
    if (tag === "img") return "image";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "p") return "paragraph";
    if (tag === "li") return "list item";
    if (tag === "section") return "section";
    if (tag === "article") return "article";
    if (tag === "nav") return "navigation";
    return "element";
  }

  function sameText(left, right) {
    return normalizeWhitespace(left).toLowerCase() === normalizeWhitespace(right).toLowerCase();
  }

  function semanticClassName(element) {
    return Array.from(element.classList || []).find((name) => isSemanticClassName(name)) || "";
  }

  function isSemanticClassName(name) {
    if (!name || name.startsWith("local-annotator") || !/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name)) {
      return false;
    }

    if (!isHumanToken(name) || /^(css|sc|jsx|emotion|astro|svelte)-/i.test(name)) {
      return false;
    }

    const utilityPatterns = [
      /^(flex|grid|block|inline|hidden|contents|absolute|relative|fixed|sticky)$/,
      /^(text|bg|from|to|via|border|ring|shadow|rounded|font|leading|tracking|opacity|z|order|col|row)-/,
      /^(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|min-w|min-h|max-w|max-h|gap|space|top|right|bottom|left|inset|translate|scale|rotate)-/,
      /^(items|justify|content|self|place|overflow|object|duration|ease|delay)-/,
      /^(hover|focus|active|disabled|sm|md|lg|xl|2xl):/
    ];

    return !utilityPatterns.some((pattern) => pattern.test(name));
  }

  function isHumanToken(value) {
    const token = String(value || "");
    if (!token || token.length > 72 || /^\d+$/.test(token)) {
      return false;
    }

    if (/^[a-f0-9]{8,}$/i.test(token) || /[a-f0-9]{10,}$/i.test(token)) {
      return false;
    }

    if (/(^|[-_])(css|sc|jsx|emotion|generated|hash)[-_]?[a-z0-9]{5,}/i.test(token)) {
      return false;
    }

    const chunks = token.split(/[-_:]/).filter(Boolean);
    const randomish = chunks.some((chunk) => chunk.length >= 10 && /^[a-z0-9]+$/i.test(chunk) && /[a-z]/i.test(chunk) && /\d/.test(chunk));
    return !randomish;
  }

  function exactShortVisibleText(element) {
    const text = normalizeWhitespace(element.innerText || element.textContent || "");
    if (!text || text.length > 80 || text.includes("\n")) {
      return "";
    }

    return text;
  }

  function isUniqueTextLocator(tag, text, element) {
    const matches = findTextLocatorMatches(tag, text);
    return matches.length === 1 && matches[0] === element;
  }

  function findByTextLocator(tag, text) {
    const matches = findTextLocatorMatches(tag, text);
    return matches.length === 1 ? matches[0] : null;
  }

  function findTextLocatorMatches(tag, text) {
    return Array.from(document.querySelectorAll(tag)).filter((element) => normalizeWhitespace(element.innerText || element.textContent || "") === text);
  }

  function parseTextLocator(selector) {
    const match = String(selector).match(/^([a-z][a-z0-9-]*):has-text\("((?:\\.|[^"])*)"\)$/i);
    if (!match) {
      return null;
    }

    return {
      tag: match[1],
      text: match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    };
  }

  function detectReact(element) {
    const fiber = reactFiberFor(element);
    if (!fiber) {
      return { components: "", source: "" };
    }

    const names = [];
    let source = "";
    let cursor = fiber;

    while (cursor) {
      const name = reactFiberName(cursor);
      if (name && !names.includes(name)) {
        names.push(name);
      }

      const debugSource = cursor._debugSource || cursor._debugOwner?._debugSource;
      if (!source && debugSource?.fileName) {
        source = `${debugSource.fileName}${debugSource.lineNumber ? `:${debugSource.lineNumber}` : ""}${debugSource.columnNumber ? `:${debugSource.columnNumber}` : ""}`;
      }

      cursor = cursor.return;
    }

    return {
      components: names.reverse().join(" > "),
      source
    };
  }

  function reactFiberFor(element) {
    let cursor = element;

    while (cursor && cursor !== document.documentElement) {
      const key = Object.keys(cursor).find((item) => item.startsWith("__reactFiber$") || item.startsWith("__reactInternalInstance$"));
      if (key) {
        return cursor[key];
      }
      cursor = cursor.parentElement;
    }

    return null;
  }

  function reactFiberName(fiber) {
    const type = fiber.elementType || fiber.type;
    if (!type) {
      return "";
    }

    if (typeof type === "string") {
      return "";
    }

    return type.displayName || type.name || fiber._debugOwner?.type?.displayName || fiber._debugOwner?.type?.name || "";
  }

  function composeContextPreview(annotation) {
    const parts = [
      `selector: ${annotation.elementPath}`,
      `fullPath: ${annotation.fullPath}`,
      `position: ${annotation.boundingBox.x}, ${annotation.boundingBox.y} (${annotation.boundingBox.width}x${annotation.boundingBox.height})`
    ];

    if (annotation.reactComponents) parts.push(`react: ${annotation.reactComponents}`);
    if (annotation.source) parts.push(`source: ${annotation.source}`);
    if (annotation.selectedText) parts.push(`selectedText: ${annotation.selectedText}`);
    if (annotation.nearbyText) parts.push(`nearbyText: ${truncate(annotation.nearbyText, 220)}`);

    return parts.join("\n");
  }

  function scopeOptions(selected) {
    const current = normalizeScope(selected);
    return ["element", "component", "global"]
      .map((value) => option(value, value, current))
      .join("");
  }

  function normalizeScope(value) {
    return ["element", "component", "global"].includes(String(value)) ? String(value) : "element";
  }

  function lucideIcon(name) {
    const attrs = 'class="local-annotator-lucide" viewBox="0 0 24 24" aria-hidden="true"';
    const icons = {
      crosshair: `<svg ${attrs}><circle cx="12" cy="12" r="10"></circle><line x1="22" x2="18" y1="12" y2="12"></line><line x1="6" x2="2" y1="12" y2="12"></line><line x1="12" x2="12" y1="6" y2="2"></line><line x1="12" x2="12" y1="22" y2="18"></line></svg>`,
      eye: `<svg ${attrs}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
      pause: `<svg ${attrs}><rect x="14" y="4" width="4" height="16" rx="1"></rect><rect x="6" y="4" width="4" height="16" rx="1"></rect></svg>`,
      copy: `<svg ${attrs}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`,
      "mouse-pointer-2": `<svg ${attrs}><path d="m4 4 7.07 17 2.51-7.39L21 11.07z"></path><path d="m11.07 11.07 4.24 4.24"></path></svg>`,
      "trash-2": `<svg ${attrs}><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" x2="10" y1="11" y2="17"></line><line x1="14" x2="14" y1="11" y2="17"></line></svg>`,
      x: `<svg ${attrs}><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`
    };

    return icons[name] || "";
  }

  function firstAttribute(element, names) {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value) {
        return { name, value };
      }
    }
    return null;
  }

  function isAnnotatorElement(target) {
    return target instanceof Element && Boolean(target.closest(".local-annotator-hover-ring, .local-annotator-target-ring, .local-annotator-marker, .local-annotator-composer, .local-annotator-toast, .local-annotator-toolbar"));
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
  }

  function pageKey() {
    return `${PAGE_PREFIX}${location.origin}${location.pathname}${location.search}`;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    return new Promise((resolve) => chrome.storage.local.set(value, resolve));
  }

  async function writeClipboard(text, annotations = []) {
    try {
      const html = clipboardHtml(text, annotations);
      if (window.ClipboardItem && navigator.clipboard.write && html) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" })
          })
        ]);
        return true;
      }

      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.documentElement.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  function clipboardHtml(markdown, annotations) {
    const shots = annotations
      .map((annotation, index) => ({ annotation, index }))
      .filter(({ annotation }) => annotation.shot?.dataUrl);

    if (!shots.length) {
      return "";
    }

    const figures = shots
      .map(({ annotation, index }) => {
        const alt = `Image crop for annotation ${index + 1}`;
        return `<figure><img src="${annotation.shot.dataUrl}" alt="${escapeAttr(alt)}"></figure>`;
      })
      .join("");

    return `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(markdown)}</pre>${figures}`;
  }

  function toast(message) {
    dom.toast?.remove();
    dom.toast = document.createElement("div");
    dom.toast.className = "local-annotator-toast";
    dom.toast.textContent = message;
    document.documentElement.appendChild(dom.toast);
    window.setTimeout(() => {
      dom.toast?.remove();
      dom.toast = null;
    }, 2200);
  }

  function option(value, label, selected) {
    return `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function truncate(value, max) {
    const text = normalizeWhitespace(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function round(value, decimals = 0) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
})();

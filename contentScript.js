(() => {
  if (window.__localUiAnnotatorLoaded) {
    return;
  }

  window.__localUiAnnotatorLoaded = true;

  const PAGE_PREFIX = "anny:page:";
  const SETTINGS_KEY = "anny:settings";
  const REFERENCE_PICKER_KEY = "anny:reference-picker";
  const MAX_TEXT = 700;
  const SHOT_MAX_LONG_EDGE = 480;
  const SHOT_DEFAULT_MAX_BYTES = 512 * 1024;
  const SHOT_MIN_MAX_BYTES = 96 * 1024;
  const SHOT_JPEG_QUALITY = 0.6;
  const SNIPPET_MAX = 300;
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
  const ANNOTATOR_CHROME_SELECTOR = [
    ".local-annotator-hover-ring",
    ".local-annotator-target-ring",
    ".local-annotator-marker",
    ".local-annotator-composer",
    ".local-annotator-toast",
    ".local-annotator-toolbar",
    ".local-annotator-reference-picker",
    ".local-annotator-clear-confirm"
  ].join(", ");
  const ANNOTATOR_ELEMENT_SELECTOR = ANNOTATOR_CHROME_SELECTOR;
  const TOP_LAYER_HOST_SELECTOR = "dialog[open], [popover]";

  const defaultSettings = {
    markersVisible: true,
    animationsPaused: false,
    dropAppliedAnnotations: false,
    shotMaxBytes: SHOT_DEFAULT_MAX_BYTES,
    toolbarPosition: null
  };

  const state = {
    annotations: [],
    feedbackEnabled: false,
    toolbarVisible: false,
    markersVisible: true,
    animationsPaused: false,
    dropAppliedAnnotations: false,
    shotMaxBytes: SHOT_DEFAULT_MAX_BYTES,
    toolbarPosition: null,
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
    clearConfirm: null,
    referencePicker: null,
    toast: null
  };

  let currentPageKey = pageKey();
  let hoveredElement = null;
  let lastSelection = null;
  let overlayLayerObserver = null;
  let overlayLayerFrame = 0;
  let toolbarDrag = null;
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
  document.addEventListener("toggle", onTopLayerToggle, true);
  window.addEventListener("scroll", syncHoverRing, true);
  window.addEventListener("resize", onViewportResize);

  init();

  async function init() {
    await loadStateForPage();
    renderToolbar();
    renderReferencePicker();
    renderMarkers();
    applyPausedState();
    watchUrlChanges();
    watchOverlayLayerChanges();
    syncAnnotatorUiLayer();
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
      state.feedbackEnabled = !state.referencePicker;
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
        state.feedbackEnabled = !state.referencePicker;
        closeComposer();
        renderToolbar();
        syncHoverRing();
      }
      return ok();
    }

    if (message.type === "annotator:toggle-feedback") {
      if (state.referencePicker) {
        state.feedbackEnabled = false;
        renderToolbar();
        toast("Reference picker active. Use Capture to select the reference.");
        return ok();
      }

      state.toolbarVisible = true;
      state.feedbackEnabled = !state.feedbackEnabled;
      closeComposer();
      renderToolbar();
      syncHoverRing();
      toast(state.feedbackEnabled ? "Feedback mode on. Click an element." : "Feedback mode off.");
      return ok();
    }

    if (message.type === "annotator:set-feedback") {
      state.feedbackEnabled = state.referencePicker ? false : Boolean(message.enabled);
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
      closeClearConfirm();
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
      const markdownExport = buildMarkdownExport(state.annotations);
      return {
        ok: true,
        state: publicState(),
        markdown: markdownExport.markdown
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
      dropAppliedAnnotations: state.dropAppliedAnnotations,
      shotMaxBytes: state.shotMaxBytes,
      baseHash: state.baseHash,
      baseCapturedAt: state.baseCapturedAt,
      referencePickerActive: Boolean(state.referencePicker),
      url: location.href,
      title: document.title
    };
  }

  async function loadStateForPage() {
    currentPageKey = pageKey();
    const stored = await storageGet([currentPageKey, SETTINGS_KEY, REFERENCE_PICKER_KEY]);
    const page = stored[currentPageKey] || {};
    const settings = { ...defaultSettings, ...(stored[SETTINGS_KEY] || {}) };

    state.annotations = Array.isArray(page.annotations) ? page.annotations.map(stripRemovedAnnotationFields) : [];
    state.markersVisible = settings.markersVisible;
    state.animationsPaused = settings.animationsPaused;
    state.dropAppliedAnnotations = Boolean(settings.dropAppliedAnnotations);
    state.shotMaxBytes = normalizeShotMaxBytes(settings.shotMaxBytes);
    state.toolbarPosition = normalizeToolbarPosition(settings.toolbarPosition);
    state.baseHash = typeof page.baseHash === "string" ? page.baseHash : "";
    state.baseCapturedAt = typeof page.baseCapturedAt === "string" ? page.baseCapturedAt : "";
    state.referencePicker = normalizeReferencePicker(stored[REFERENCE_PICKER_KEY]);
    if (state.referencePicker) {
      state.toolbarVisible = true;
      state.feedbackEnabled = false;
    }
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
        animationsPaused: state.animationsPaused,
        dropAppliedAnnotations: state.dropAppliedAnnotations,
        shotMaxBytes: state.shotMaxBytes,
        toolbarPosition: state.toolbarPosition
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
    if (!(state.feedbackEnabled || state.referencePicker?.captureArmed) || isAnnotatorElement(event.target)) {
      return;
    }

    const target = elementAt(event.clientX, event.clientY, event);
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

    scheduleAnnotatorUiLayerSync();

    if (state.referencePicker?.captureArmed) {
      const target = elementAt(event.clientX, event.clientY, event);
      if (!target || target === document.documentElement) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      captureReferenceTarget(target).catch(() => {
        toast("Reference capture failed.");
      });
      return;
    }

    if (state.referencePicker) {
      return;
    }

    if (!state.feedbackEnabled) {
      return;
    }

    const target = elementAt(event.clientX, event.clientY, event);
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
    if (!state.toolbarVisible && !state.referencePicker) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === "escape") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (state.referencePicker) {
        clearReferencePicker().then(() => {
          toast("Reference picker cancelled.");
        });
        return;
      }
      closeToolbar();
      return;
    }

    if (isTypingTarget(event.target)) {
      return;
    }

    const modifier = event.metaKey || event.ctrlKey;

    if (modifier && event.shiftKey && key === "f") {
      event.preventDefault();
      if (state.referencePicker) {
        state.feedbackEnabled = false;
        renderToolbar();
        toast("Reference picker active. Use Capture to select the reference.");
        return;
      }

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
      closeClearConfirm();
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

  function onTopLayerToggle(event) {
    if (event.target instanceof Element && !isAnnotatorElement(event.target) && matchesSelector(event.target, TOP_LAYER_HOST_SELECTOR)) {
      scheduleAnnotatorUiLayerSync();
    }
  }

  function onViewportResize() {
    syncHoverRing();
    placeToolbar();
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
    }
    appendAnnotatorNode(dom.hoverRing, annotatorHostForElement(element));

    Object.assign(dom.hoverRing.style, {
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${Math.max(1, rect.height)}px`
    });

    dom.hoverRing.dataset.label = elementLabel(element);
  }

  function syncHoverRing() {
    if (!(state.feedbackEnabled || state.referencePicker?.captureArmed) || !hoveredElement) {
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
    }
    appendAnnotatorNode(dom.targetRing, annotatorHostForElement(element));

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

    appendAnnotatorNode(composer, annotatorHostForElement(element));
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

      const scope = normalizeScope(formData.get("scope"));
      const targetForMetadata = targetElementForMetadata(existingAnnotation, element);
      const targetMetadata = targetForMetadata ? collectTargetMetadata(targetForMetadata, scope, snapshot.matchSignature) : null;
      const nextAnnotation = {
        ...snapshot,
        comment,
        scope,
        reference: normalizeWhitespace(formData.get("reference")),
        targetFingerprint: snapshot.targetFingerprint || targetMetadata?.targetFingerprint || "",
        targetText: snapshot.targetText || targetMetadata?.targetText || "",
        snippet: targetMetadata?.snippet || snapshot.snippet || "",
        matchSignature: targetMetadata?.matchSignature || snapshot.matchSignature || "",
        matchedSet: scope === "element" ? null : targetMetadata?.matchedSet || snapshot.matchedSet || null,
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
    composer.querySelector("[data-pick-reference]")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await startReferencePicker(composer, snapshot, existingAnnotation);
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
    dom.composer?.remove();
    dom.composer = null;
    hideTargetRing();
  }

  function closeToolbar() {
    state.toolbarVisible = false;
    state.feedbackEnabled = false;
    if (toolbarDrag) {
      finishToolbarDrag(false);
    }
    closeComposer();
    closeClearConfirm();
    hideHoverRing();
    renderToolbar();
  }

  function appendAnnotatorNode(node, host = document.documentElement) {
    const nextHost = host?.isConnected ? host : document.documentElement;
    if (node.parentElement !== nextHost || node.nextElementSibling) {
      nextHost.appendChild(node);
    }
  }

  function activeAnnotatorHost(preferredElement = null) {
    return topLayerHostForElement(preferredElement) || activeTopLayerHost() || document.documentElement;
  }

  function annotatorHostForElement(element) {
    return topLayerHostForElement(element) || document.documentElement;
  }

  function activeTopLayerHost() {
    const hosts = Array.from(document.querySelectorAll(TOP_LAYER_HOST_SELECTOR)).filter((element) => {
      return !isAnnotatorElement(element) && isOpenTopLayerHost(element);
    });

    return hosts[hosts.length - 1] || null;
  }

  function topLayerHostForElement(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    const host = element.closest(TOP_LAYER_HOST_SELECTOR);
    if (!host?.isConnected) {
      return null;
    }

    if (isOpenTopLayerHost(host)) {
      return host;
    }

    return null;
  }

  function isOpenTopLayerHost(element) {
    return matchesSelector(element, "dialog[open]") || matchesSelector(element, ":popover-open");
  }

  function matchesSelector(element, selector) {
    try {
      return element instanceof Element && element.matches(selector);
    } catch (_error) {
      return false;
    }
  }

  function syncAnnotatorUiLayer() {
    const host = activeAnnotatorHost();

    if (state.toolbarVisible && dom.toolbar) {
      appendAnnotatorNode(dom.toolbar, host);
      placeToolbar();
    }

    if (dom.clearConfirm) {
      appendAnnotatorNode(dom.clearConfirm, host);
      placeClearConfirm();
    }

    if (dom.referencePicker) {
      appendAnnotatorNode(dom.referencePicker, host);
    }

    if (dom.toast) {
      appendAnnotatorNode(dom.toast, host);
    }
  }

  function scheduleAnnotatorUiLayerSync() {
    if (!state.toolbarVisible && !dom.clearConfirm && !dom.referencePicker && !dom.toast) {
      return;
    }

    if (overlayLayerFrame) {
      return;
    }

    overlayLayerFrame = window.requestAnimationFrame(() => {
      overlayLayerFrame = 0;
      syncAnnotatorUiLayer();
    });
  }

  function watchOverlayLayerChanges() {
    if (overlayLayerObserver) {
      return;
    }

    overlayLayerObserver = new MutationObserver((mutations) => {
      if (!mutations.some(shouldSyncAnnotatorLayerForMutation)) {
        return;
      }

      scheduleAnnotatorUiLayerSync();
    });

    overlayLayerObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "popover", "aria-modal", "hidden"]
    });
  }

  function shouldSyncAnnotatorLayerForMutation(mutation) {
    if (!state.toolbarVisible && !dom.clearConfirm && !dom.referencePicker && !dom.toast) {
      return false;
    }

    if (mutation.target instanceof Element && isAnnotatorElement(mutation.target)) {
      return false;
    }

    if (mutation.type === "childList") {
      return Array.from(mutation.addedNodes).some(isElementNode) || Array.from(mutation.removedNodes).some(isElementNode);
    }

    return mutation.target instanceof Element;
  }

  function isElementNode(node) {
    return node instanceof Element && !isAnnotatorElement(node);
  }

  async function startReferencePicker(composer, snapshot, existingAnnotation) {
    const now = new Date().toISOString();
    const originBaseHash = state.baseHash || domSnapshotHash();
    const originBaseCapturedAt = state.baseCapturedAt || now;
    const picker = {
      id: `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      originPageKey: currentPageKey,
      originUrl: location.href,
      originTitle: document.title,
      originBaseHash,
      originBaseCapturedAt,
      annotationId: existingAnnotation?.id || snapshot.id,
      draft: draftAnnotationFromComposer(composer, snapshot),
      captureArmed: false,
      startedAt: now,
      updatedAt: now
    };

    state.baseHash = state.baseHash || originBaseHash;
    state.baseCapturedAt = state.baseCapturedAt || originBaseCapturedAt;
    state.referencePicker = picker;
    state.feedbackEnabled = false;

    await saveReferencePicker(picker);
    await notifyReferencePickerStarted().catch(() => {});
    closeComposer();
    hideHoverRing();
    renderToolbar();
    renderReferencePicker();
    toast("Reference picker active. Navigate to the reference, then click Capture.");
  }

  function draftAnnotationFromComposer(composer, snapshot) {
    const formData = new FormData(composer);
    return {
      ...snapshot,
      comment: String(formData.get("comment") || "").trim(),
      scope: normalizeScope(formData.get("scope")),
      reference: normalizeWhitespace(formData.get("reference")),
      updatedAt: new Date().toISOString()
    };
  }

  async function captureReferenceTarget(target) {
    const picker = state.referencePicker;
    if (!picker) {
      return;
    }

    const reference = referenceValueForTarget(target, picker);
    await saveReferencePicker({ ...picker, captureArmed: false });
    hideHoverRing();
    renderReferencePicker();
    await saveReferenceToOrigin(picker, reference);
    await clearReferencePicker();
    toast("Reference saved to the original annotation.");
  }

  async function saveReferenceToOrigin(picker, reference) {
    const originPageKey = picker.originPageKey || currentPageKey;
    const stored = await storageGet(originPageKey);
    const page = stored[originPageKey] || {};
    const annotations = Array.isArray(page.annotations) ? page.annotations.map(stripRemovedAnnotationFields) : [];
    const now = new Date().toISOString();
    const draft = stripRemovedAnnotationFields({
      ...(picker.draft || {}),
      id: picker.annotationId || picker.draft?.id || `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      url: picker.draft?.url || picker.originUrl || location.href,
      title: picker.draft?.title || picker.originTitle || document.title,
      reference,
      updatedAt: now
    });
    const existingIndex = annotations.findIndex((annotation) => annotation.id === draft.id);

    if (existingIndex >= 0) {
      annotations[existingIndex] = stripRemovedAnnotationFields({
        ...annotations[existingIndex],
        ...draft
      });
    } else {
      annotations.push(draft);
    }

    const baseHash = page.baseHash || picker.originBaseHash || "";
    const baseCapturedAt = page.baseCapturedAt || picker.originBaseCapturedAt || "";
    const nextPage = {
      url: page.url || picker.originUrl || location.href,
      title: page.title || picker.originTitle || document.title,
      updatedAt: now,
      baseHash,
      baseCapturedAt,
      annotations
    };

    await storageSet({ [originPageKey]: nextPage });

    if (originPageKey === currentPageKey) {
      state.annotations = annotations;
      state.baseHash = baseHash;
      state.baseCapturedAt = baseCapturedAt;
      renderMarkers();
      renderToolbar();
    }
  }

  function referenceValueForTarget(target, picker) {
    const selectorInfo = getRobustSelectorInfo(target);
    const anchor = selectorInfo.positional ? `${selectorInfo.selector} (positional - may drift)` : selectorInfo.selector;
    if (picker.originPageKey === currentPageKey) {
      return anchor;
    }

    const locator = humanLocator(target);
    const title = document.title || "Untitled page";
    return `${title} - ${location.href} - ${locator} - anchor: ${anchor}`;
  }

  async function saveReferencePicker(picker) {
    const nextPicker = {
      ...picker,
      updatedAt: new Date().toISOString()
    };
    const stored = await storageGet(REFERENCE_PICKER_KEY);
    const storedPicker = stored[REFERENCE_PICKER_KEY];
    if (!nextPicker.tabId && storedPicker?.id === nextPicker.id && storedPicker.tabId) {
      nextPicker.tabId = storedPicker.tabId;
    }

    state.referencePicker = nextPicker;
    await storageSet({ [REFERENCE_PICKER_KEY]: nextPicker });
  }

  async function clearReferencePicker() {
    state.referencePicker = null;
    await storageRemove(REFERENCE_PICKER_KEY);
    await notifyReferencePickerEnded().catch(() => {});
    hideHoverRing();
    renderReferencePicker();
    renderToolbar();
  }

  function normalizeReferencePicker(value) {
    if (!value || typeof value !== "object" || !value.id || !value.originPageKey) {
      return null;
    }

    return {
      ...value,
      draft: value.draft && typeof value.draft === "object" ? stripRemovedAnnotationFields(value.draft) : {},
      captureArmed: Boolean(value.captureArmed)
    };
  }

  function notifyReferencePickerStarted() {
    return sendRuntimeMessage({ type: "annotator:reference-picker-started" });
  }

  function notifyReferencePickerEnded() {
    return sendRuntimeMessage({ type: "annotator:reference-picker-ended" });
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

      const target = safeQuery(annotation.elementPath) || safeQuery(annotation.fullPath);
      placeMarker(marker, annotation, target);
      appendAnnotatorNode(marker, annotatorHostForElement(target));
    });
  }

  function placeMarker(marker, annotation, target) {
    const host = topLayerHostForElement(target);
    if (!host) {
      marker.style.left = `${annotation.marker.x}px`;
      marker.style.top = `${annotation.marker.y}px`;
      return;
    }

    const rect = target.getBoundingClientRect();
    marker.style.position = "fixed";
    marker.style.left = `${Math.max(0, rect.left + Math.min(rect.width - 14, 10))}px`;
    marker.style.top = `${Math.max(0, rect.top + Math.min(rect.height - 14, 10))}px`;
  }

  function onToolbarPointerDown(event) {
    const handle = event.target instanceof Element ? event.target.closest("[data-toolbar-drag]") : null;
    if (!handle || !dom.toolbar?.contains(handle)) {
      return;
    }

    const rect = dom.toolbar.getBoundingClientRect();
    toolbarDrag = {
      pointerId: event.pointerId,
      captureTarget: handle,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    captureToolbarPointer(handle, event.pointerId);
    dom.toolbar.classList.add("is-dragging");
    document.addEventListener("pointermove", onToolbarPointerMove, true);
    document.addEventListener("pointerup", onToolbarPointerUp, true);
    document.addEventListener("pointercancel", onToolbarPointerCancel, true);
  }

  function onToolbarPointerMove(event) {
    if (!toolbarDrag || event.pointerId !== toolbarDrag.pointerId || !dom.toolbar) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const rect = dom.toolbar.getBoundingClientRect();
    state.toolbarPosition = clampToolbarPosition({
      x: event.clientX - toolbarDrag.offsetX,
      y: event.clientY - toolbarDrag.offsetY
    }, rect.width, rect.height);
    applyToolbarPosition();
    placeClearConfirm();
  }

  function onToolbarPointerUp(event) {
    if (!toolbarDrag || event.pointerId !== toolbarDrag.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    finishToolbarDrag(true);
  }

  function onToolbarPointerCancel(event) {
    if (!toolbarDrag || event.pointerId !== toolbarDrag.pointerId) {
      return;
    }

    finishToolbarDrag(false);
  }

  function finishToolbarDrag(shouldSave) {
    const drag = toolbarDrag;
    toolbarDrag = null;
    releaseToolbarPointer(drag);
    dom.toolbar?.classList.remove("is-dragging");
    document.removeEventListener("pointermove", onToolbarPointerMove, true);
    document.removeEventListener("pointerup", onToolbarPointerUp, true);
    document.removeEventListener("pointercancel", onToolbarPointerCancel, true);

    if (shouldSave) {
      saveSettings();
    }
  }

  function captureToolbarPointer(handle, pointerId) {
    try {
      handle.setPointerCapture?.(pointerId);
    } catch (_error) {
      // Pointer capture is best effort; document listeners still handle standard drags.
    }
  }

  function releaseToolbarPointer(drag) {
    try {
      if (drag?.captureTarget?.hasPointerCapture?.(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch (_error) {
      // The browser may release capture automatically before pointerup.
    }
  }

  function placeToolbar() {
    if (!dom.toolbar) {
      return;
    }

    if (!state.toolbarPosition) {
      Object.assign(dom.toolbar.style, {
        left: "",
        top: "",
        right: "",
        bottom: ""
      });
      placeClearConfirm();
      return;
    }

    const rect = dom.toolbar.getBoundingClientRect();
    state.toolbarPosition = clampToolbarPosition(state.toolbarPosition, rect.width, rect.height);
    applyToolbarPosition();
    placeClearConfirm();
  }

  function applyToolbarPosition() {
    if (!dom.toolbar || !state.toolbarPosition) {
      return;
    }

    Object.assign(dom.toolbar.style, {
      left: `${state.toolbarPosition.x}px`,
      top: `${state.toolbarPosition.y}px`,
      right: "auto",
      bottom: "auto"
    });
  }

  function clampToolbarPosition(position, width, height) {
    const margin = 8;
    const x = Number(position?.x);
    const y = Number(position?.y);
    const nextX = Number.isFinite(x) ? x : margin;
    const nextY = Number.isFinite(y) ? y : margin;
    const maxX = Math.max(margin, window.innerWidth - Math.max(1, width) - margin);
    const maxY = Math.max(margin, window.innerHeight - Math.max(1, height) - margin);

    return {
      x: round(clamp(nextX, margin, maxX), 1),
      y: round(clamp(nextY, margin, maxY), 1)
    };
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
        <button type="button" class="local-annotator-toolbar-grip" data-toolbar-drag="true" aria-label="Move toolbar" data-tooltip="Move"><i aria-hidden="true"></i></button>
        <button type="button" data-action="feedback" aria-label="Toggle feedback mode" data-tooltip="Annotate">${lucideIcon("crosshair")}</button>
        <button type="button" data-action="markers" aria-label="Show or hide markers" data-tooltip="Markers">${lucideIcon("eye")}</button>
        <button type="button" data-action="pause" aria-label="Pause animations and media" data-tooltip="Pause motion">${lucideIcon("pause")}</button>
        <button type="button" data-action="copy" aria-label="Copy annotations" data-tooltip="Copy">${lucideIcon("copy")}</button>
        <button type="button" data-action="clear" aria-label="Clear annotations" data-tooltip="Clear">${lucideIcon("trash-2")}</button>
        <button type="button" data-action="close" aria-label="Close annotator toolbar" data-tooltip="Close">${lucideIcon("x")}</button>
        <span data-count>0</span>
      `;

      dom.toolbar.addEventListener("pointerdown", onToolbarPointerDown, true);
      dom.toolbar.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (button.dataset.action !== "clear") {
          closeClearConfirm();
        }

        if (button.dataset.action === "close") {
          closeToolbar();
          return;
        }

        if (button.dataset.action === "feedback") {
          if (state.referencePicker) {
            state.feedbackEnabled = false;
            toast("Reference picker active. Use Capture to select the reference.");
            renderToolbar();
            return;
          }

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
          showClearConfirm();
          return;
        }

        renderToolbar();
      });
    }
    appendAnnotatorNode(dom.toolbar, activeAnnotatorHost());
    placeToolbar();

    const feedback = dom.toolbar.querySelector('[data-action="feedback"]');
    const markers = dom.toolbar.querySelector('[data-action="markers"]');
    const pause = dom.toolbar.querySelector('[data-action="pause"]');
    const count = dom.toolbar.querySelector("[data-count]");

    feedback.classList.toggle("is-active", state.feedbackEnabled);
    markers.classList.toggle("is-active", state.markersVisible);
    pause.classList.toggle("is-active", state.animationsPaused);
    count.textContent = String(state.annotations.length);
  }

  function showClearConfirm() {
    if (!state.annotations.length) {
      closeClearConfirm();
      toast("No annotations to clear.");
      return;
    }

    if (!dom.clearConfirm) {
      dom.clearConfirm = document.createElement("div");
      dom.clearConfirm.className = "local-annotator-clear-confirm";
      dom.clearConfirm.innerHTML = `
        <strong>Clear?</strong>
        <button type="button" data-clear-confirm="yes">Yes</button>
        <button type="button" data-clear-confirm="no">No</button>
      `;
      dom.clearConfirm.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-clear-confirm]");
        if (!button) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (button.dataset.clearConfirm === "no") {
          closeClearConfirm();
          return;
        }

        closeClearConfirm();
        await clearAnnotationsFromToolbar();
      });
    }
    appendAnnotatorNode(dom.clearConfirm, activeAnnotatorHost());
    placeClearConfirm();
  }

  function closeClearConfirm() {
    dom.clearConfirm?.remove();
    dom.clearConfirm = null;
  }

  function placeClearConfirm() {
    if (!dom.clearConfirm || !dom.toolbar) {
      return;
    }

    const gap = 8;
    const margin = 8;
    const toolbarRect = dom.toolbar.getBoundingClientRect();
    const confirmRect = dom.clearConfirm.getBoundingClientRect();
    const width = Math.max(1, confirmRect.width);
    const height = Math.max(1, confirmRect.height);
    const centerX = toolbarRect.left + toolbarRect.width / 2;
    const left = clamp(centerX - width / 2, margin, window.innerWidth - width - margin);
    const above = toolbarRect.top - height - gap;
    const below = toolbarRect.bottom + gap;
    const top = above >= margin
      ? above
      : clamp(below, margin, window.innerHeight - height - margin);

    Object.assign(dom.clearConfirm.style, {
      left: `${round(left, 1)}px`,
      top: `${round(top, 1)}px`,
      right: "auto",
      bottom: "auto"
    });
  }

  async function clearAnnotationsFromToolbar() {
    clearPageFeedback();
    await saveAnnotations();
    renderMarkers();
    closeComposer();
    renderToolbar();
    toast("Cleared annotations for this page.");
  }

  function renderReferencePicker() {
    const picker = state.referencePicker;
    if (!picker) {
      dom.referencePicker?.remove();
      dom.referencePicker = null;
      return;
    }

    if (!dom.referencePicker) {
      dom.referencePicker = document.createElement("div");
      dom.referencePicker.className = "local-annotator-reference-picker";
      dom.referencePicker.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-reference-action]");
        if (!button) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (button.dataset.referenceAction === "capture") {
          await saveReferencePicker({
            ...state.referencePicker,
            captureArmed: !state.referencePicker?.captureArmed
          });
          state.feedbackEnabled = false;
          renderReferencePicker();
          renderToolbar();
          syncHoverRing();
          toast(state.referencePicker.captureArmed ? "Click the reference element." : "Reference capture paused.");
          return;
        }

        if (button.dataset.referenceAction === "cancel") {
          await clearReferencePicker();
          toast("Reference picker cancelled.");
        }
      });
    }
    appendAnnotatorNode(dom.referencePicker, activeAnnotatorHost());

    const origin = picker.originTitle || picker.originUrl || "original annotation";
    const instruction = picker.captureArmed
      ? "Click the reference element now."
      : "Navigate normally, then arm capture when the reference is visible.";

    dom.referencePicker.classList.toggle("is-armed", picker.captureArmed);
    dom.referencePicker.innerHTML = `
      <div>
        <strong>${picker.captureArmed ? "Capturing reference" : "Reference picker active"}</strong>
        <span>${escapeHtml(instruction)}</span>
        <small>For: ${escapeHtml(origin)}</small>
      </div>
      <button type="button" data-reference-action="capture">${picker.captureArmed ? "Pause" : "Capture"}</button>
      <button type="button" data-reference-action="cancel">Cancel</button>
    `;
  }

  async function copyFromPage() {
    if (!state.annotations.length) {
      toast("No annotations to copy.");
      return;
    }

    ensureBaseCapture();
    await saveAnnotations();
    const markdownExport = buildMarkdownExport(state.annotations);
    const copied = await writeClipboard(markdownExport.markdown, markdownExport.includedAnnotations);
    toast(copied ? copiedToast(markdownExport) : "Copy failed. Check clipboard permission and try again.");
  }

  function copiedToast(markdownExport) {
    const count = markdownExport.includedAnnotations.length;
    const omitted = state.dropAppliedAnnotations ? markdownExport.summary.alreadyApplied : 0;
    const base = `Copied ${count} annotation${count === 1 ? "" : "s"}`;

    return omitted ? `${base} (${omitted} already applied omitted).` : `${base}.`;
  }

  function collectElementContext(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    const selectorInfo = getRobustSelectorInfo(element);
    const selector = selectorInfo.selector;
    const fullPath = getFullPath(element);
    const react = detectReact(element);
    const attrs = relevantAttributes(element);
    const targetMetadata = collectTargetMetadata(element);
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
      targetFingerprint: targetMetadata.targetFingerprint,
      targetText: targetMetadata.targetText,
      snippet: targetMetadata.snippet,
      matchSignature: targetMetadata.matchSignature,
      matchedSet: null,
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
    return buildMarkdownExport(annotations).markdown;
  }

  function buildMarkdownExport(annotations) {
    if (!annotations.length) {
      return {
        markdown: "",
        includedAnnotations: [],
        summary: emptyStatusSummary()
      };
    }

    const prepared = prepareAnnotationExports(annotations);
    const included = state.dropAppliedAnnotations
      ? prepared.items.filter((item) => item.status.kind !== "already-applied")
      : prepared.items;
    const includedAnnotations = included.map((item) => item.annotation);
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
    lines.push(agentLine("apply", `all ${included.length} annotation${included.length === 1 ? "" : "s"} in this batch`));
    lines.push(agentLine("base", `${baseHash} (captured ${baseCapturedAt})`));
    lines.push("# base = hash of the DOM these notes were taken against; if it no longer matches, some items may already be applied.");
    lines.push(agentLine("fresh", `${prepared.summary.fresh} · already-applied: ${prepared.summary.alreadyApplied} · review: ${prepared.summary.review}`));

    const attachments = includedAnnotations.length ? formatAttachments(includedAnnotations) : "";
    if (attachments) {
      lines.push(agentLine("attachments", attachments));
    }

    lines.push("");

    included.forEach((item, index) => {
      const { annotation } = item;
      lines.push(`### ${index + 1}  ·  id: ${annotation.id}`);
      lines.push(agentLine("intent", annotation.comment || ""));
      lines.push(agentLine("status", item.status.text));
      lines.push(agentLine("target", `${annotation.humanLocator || humanLocatorFromAnnotation(annotation)}   ·   anchor: ${anchorForAnnotation(annotation, item.target)}`));

      const text = truncate(item.currentText || annotation.targetText || annotation.selectedText || annotation.nearbyText || "", 80);
      if (text) {
        lines.push(agentLine("text", text));
      }

      const snippet = item.snippet || annotation.snippet || "";
      if (snippet) {
        lines.push(agentLine("snippet", snippet));
      }

      const roleAria = annotation.roleAria || roleAriaFromAccessibility(annotation.accessibility);
      if (roleAria) {
        lines.push(agentLine("role/aria", roleAria));
      }

      lines.push(agentLine("scope", normalizeScope(annotation.scope)));

      if (item.matches) {
        lines.push(agentLine("matches", item.matches));
      }

      if (annotation.reference) {
        lines.push(agentLine("reference", annotation.reference));
      }
      lines.push(agentLine("shot", shotNote(annotation)));
      lines.push("");
    });

    lines.push("Implementation note: use the fields above as implementation context. Do not skip annotations because their screenshot is missing; the shot field only describes attachment availability.");

    return {
      markdown: lines.join("\n").trim() + "\n",
      includedAnnotations,
      summary: prepared.summary
    };
  }

  function prepareAnnotationExports(annotations) {
    const summary = emptyStatusSummary();
    const items = annotations.map((annotation) => {
      const target = resolveAnnotationTarget(annotation).element;
      const status = statusForAnnotation(annotation, target);
      const currentText = target ? visibleElementText(target) : "";
      const snippet = target ? outerHtmlSnippet(target) : annotation.snippet || "";
      const scope = normalizeScope(annotation.scope);

      summary[status.summaryKey] += 1;

      return {
        annotation,
        target,
        status,
        currentText,
        snippet,
        matches: scope === "element" ? "" : matchesLineForAnnotation(annotation, target, scope)
      };
    });

    return { items, summary };
  }

  function emptyStatusSummary() {
    return {
      fresh: 0,
      alreadyApplied: 0,
      review: 0
    };
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

  function anchorForAnnotation(annotation, target = null) {
    const selectorInfo = target ? getRobustSelectorInfo(target) : null;
    const selector = selectorInfo?.selector || annotation.robustSelector || annotation.elementPath || "";
    const positional = selectorInfo
      ? selectorInfo.positional
      : annotation.selectorIsPositional || annotation.selectorStrategy === "positional" || selector.includes(":nth-of-type");
    return positional ? `${selector} (positional — may drift)` : selector;
  }

  function resolveAnnotationTarget(annotation) {
    const selectors = uniqueStrings([annotation.robustSelector, annotation.elementPath, annotation.fullPath]);

    for (const selector of selectors) {
      const element = safeQuery(selector);
      if (element && !isAnnotatorElement(element)) {
        return { element, selector };
      }
    }

    return { element: null, selector: "" };
  }

  function statusForAnnotation(annotation, target) {
    if (!target) {
      return statusValue("review", "review (target not found)");
    }

    const requestedCopy = requestedCopyText(annotation.comment || "");
    if (requestedCopy && sameNormalizedText(visibleElementText(target), requestedCopy)) {
      return statusValue("alreadyApplied", "already-applied");
    }

    if (annotation.targetFingerprint && elementFingerprint(target) !== annotation.targetFingerprint) {
      return statusValue("review", "review (target changed since capture)");
    }

    return statusValue("fresh", "fresh");
  }

  function statusValue(summaryKey, text) {
    return {
      kind: summaryKey === "alreadyApplied" ? "already-applied" : summaryKey,
      summaryKey,
      text
    };
  }

  function requestedCopyText(intent) {
    const text = String(intent || "");
    const quoted = quotedStrings(text);
    if (!quoted.length) {
      return "";
    }

    const explicitCopyChange = /\b(change|update|replace|set|make|rename|retitle)\b[\s\S]{0,180}\b(to|with|say|read)\s*["'“‘]/i.test(text);
    if (explicitCopyChange) {
      return quoted[quoted.length - 1];
    }

    const copyLike = /\b(copy|text|label|headline|title|wording|caption|content|cta|button)\b/i.test(text);
    const destructiveOnly = /\b(remove|delete|hide)\b/i.test(text) && !/\b(to|with|say|read)\b/i.test(text);
    if (copyLike && !destructiveOnly) {
      return quoted[quoted.length - 1];
    }

    return "";
  }

  function quotedStrings(text) {
    const matches = [];
    const pattern = /"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’/g;
    let match = pattern.exec(text);

    while (match) {
      matches.push(match[1] || match[2] || match[3] || match[4] || "");
      match = pattern.exec(text);
    }

    return matches.map(normalizeWhitespace).filter(Boolean);
  }

  function sameNormalizedText(left, right) {
    return normalizeWhitespace(left) === normalizeWhitespace(right);
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
    clone.querySelectorAll(ANNOTATOR_ELEMENT_SELECTOR).forEach((node) => node.remove());
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

  function targetElementForMetadata(existingAnnotation, element) {
    if (!existingAnnotation) {
      return element instanceof Element ? element : null;
    }

    const resolved = resolveAnnotationTarget(existingAnnotation).element;
    if (resolved) {
      return resolved;
    }

    return element instanceof Element && element !== document.body && element !== document.documentElement ? element : null;
  }

  function collectTargetMetadata(element, scope = "element", preferredSignature = "") {
    const matchSignature = preferredSignature || primaryMatchSignature(element);

    return {
      targetFingerprint: elementFingerprint(element),
      targetText: visibleElementText(element),
      snippet: outerHtmlSnippet(element),
      matchSignature,
      matchedSet: normalizeScope(scope) === "element" ? null : collectMatchedSet(element, scope, matchSignature)
    };
  }

  function elementFingerprint(element) {
    return djb2Hash(normalizedOuterHtml(element));
  }

  function outerHtmlSnippet(element) {
    return truncate(normalizedOuterHtml(element), SNIPPET_MAX);
  }

  function normalizedOuterHtml(element) {
    return normalizeWhitespace(element?.outerHTML || "");
  }

  function visibleElementText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    if (element.tagName === "SELECT") {
      return normalizeWhitespace(Array.from(element.selectedOptions || []).map((option) => option.textContent || "").join(" "));
    }

    if (["INPUT", "TEXTAREA"].includes(element.tagName)) {
      return normalizeWhitespace(element.value || element.getAttribute("value") || element.getAttribute("placeholder") || "");
    }

    return normalizeWhitespace(
      element.innerText ||
        element.textContent ||
        element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        ""
    );
  }

  function matchesLineForAnnotation(annotation, target, scope) {
    const set = target ? collectMatchedSet(target, scope, annotation.matchSignature) : annotation.matchedSet;
    if (!set && !target) {
      return "target not found; matched set unavailable";
    }

    return formatMatchedSet(set);
  }

  function collectMatchedSet(element, scope = "component", preferredSignature = "") {
    const signature = preferredSignature || primaryMatchSignature(element);
    const matches = signature
      ? uniqueElements([element, ...safeQueryAll(signature)].filter((item) => item && !isAnnotatorElement(item)))
      : [element];

    return {
      scope: normalizeScope(scope),
      signature,
      count: matches.length,
      items: matches.map((match) => {
        const selectorInfo = getRobustSelectorInfo(match);
        return {
          anchor: selectorInfo.positional ? `${selectorInfo.selector} (positional — may drift)` : selectorInfo.selector,
          locator: humanLocator(match)
        };
      })
    };
  }

  function formatMatchedSet(set) {
    if (!set) {
      return "";
    }

    if (!set.count) {
      return "0 elements";
    }

    if (set.count === 1) {
      return "1 element (this element only)";
    }

    const anchors = set.items
      .map((item) => `${item.anchor}${item.locator ? ` (${item.locator})` : ""}`)
      .join("; ");

    return `${set.count} elements — anchors: ${anchors}`;
  }

  function primaryMatchSignature(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const className = semanticClassName(element) || firstReusableClassName(element);
    if (className) {
      return `.${cssEscape(className)}`;
    }

    const stableAttr = stableDataAttribute(element);
    if (stableAttr) {
      return dataAttributeSelector(element.tagName.toLowerCase(), stableAttr);
    }

    const role = element.getAttribute("role");
    if (role) {
      return `${element.tagName.toLowerCase()}[role="${cssString(role)}"]`;
    }

    return "";
  }

  function firstReusableClassName(element) {
    return Array.from(element.classList || []).find((name) => {
      return name && !name.startsWith("local-annotator") && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name) && !/^[a-f0-9]{8,}$/i.test(name);
    }) || "";
  }

  function safeQueryAll(selector) {
    try {
      return selector ? Array.from(document.querySelectorAll(selector)) : [];
    } catch (_error) {
      return [];
    }
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
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
        return shot || { note: "screenshot skipped (still over cap after downscale)" };
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
    const nodes = Array.from(document.querySelectorAll(ANNOTATOR_ELEMENT_SELECTOR));
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
    const maxBytes = effectiveShotMaxBytes();
    let { width, height } = scaledCropSize(crop, SHOT_MAX_LONG_EDGE);

    while (true) {
      const dataUrl = renderCrop(image, crop, dpr, width, height, "image/jpeg", SHOT_JPEG_QUALITY);
      const bytes = dataUrlBytes(dataUrl);
      if (bytes <= maxBytes) {
        return {
          note: `attached image crop (${Math.round(bytes / 1024)} KB)`,
          dataUrl,
          width,
          height,
          bytes
        };
      }

      if (Math.max(width, height) <= 80) {
        break;
      }

      width = Math.floor(width * 0.75);
      height = Math.max(1, Math.floor(height * 0.75));
    }

    return null;
  }

  function scaledCropSize(crop, maxLongEdge) {
    const sourceWidth = Math.max(1, Math.round(crop.width));
    const sourceHeight = Math.max(1, Math.round(crop.height));
    const scale = Math.min(1, maxLongEdge / Math.max(sourceWidth, sourceHeight));

    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale))
    };
  }

  function effectiveShotMaxBytes() {
    return normalizeShotMaxBytes(state.shotMaxBytes);
  }

  function normalizeShotMaxBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return SHOT_DEFAULT_MAX_BYTES;
    }

    return Math.max(SHOT_MIN_MAX_BYTES, Math.round(bytes));
  }

  function normalizeToolbarPosition(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return {
      x: round(x, 1),
      y: round(y, 1)
    };
  }

  function renderCrop(image, crop, dpr, width, height, type = "image/jpeg", quality = SHOT_JPEG_QUALITY) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
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

    return canvas.toDataURL(type, quality);
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
      renderReferencePicker();
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

    const stableAttr = stableDataAttribute(element);
    if (stableAttr && (stableAttr.value === "" || isHumanToken(stableAttr.value))) {
      const selector = dataAttributeSelector(tag, stableAttr);
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

  function elementAt(clientX, clientY, event = null) {
    const element = eventElementAtPoint(event, clientX, clientY) || underlyingElementFromPoint(clientX, clientY);
    if (!element || isAnnotatorElement(element)) {
      return null;
    }

    return element;
  }

  function underlyingElementFromPoint(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    if (element && !isAnnotatorElement(element)) {
      return element;
    }

    return withTemporarilyHiddenAnnotatorChrome(() => {
      const target = document.elementFromPoint(clientX, clientY);
      return target && !isAnnotatorElement(target) ? target : null;
    });
  }

  function withTemporarilyHiddenAnnotatorChrome(callback) {
    const nodes = Array.from(document.querySelectorAll(ANNOTATOR_ELEMENT_SELECTOR));
    const previous = nodes.map((node) => [node, node.style.visibility]);

    nodes.forEach((node) => {
      node.style.visibility = "hidden";
    });

    try {
      return callback();
    } finally {
      previous.forEach(([node, visibility]) => {
        node.style.visibility = visibility;
      });
    }
  }

  function eventElementAtPoint(event, clientX, clientY) {
    if (!event || typeof event.composedPath !== "function") {
      return null;
    }

    return event.composedPath().find((node) => {
      return node instanceof Element &&
        node !== document.documentElement &&
        node !== document.body &&
        !isAnnotatorElement(node) &&
        isPointInsideElement(node, clientX, clientY);
    }) || null;
  }

  function isPointInsideElement(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
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

  function stableDataAttribute(element) {
    const named = firstAttribute(element, STABLE_DATA_ATTRIBUTES);
    if (named && isHumanToken(named.value)) {
      return named;
    }

    return firstStableDataAttribute(element);
  }

  function firstStableDataAttribute(element) {
    return Array.from(element.attributes || []).find((attr) => {
      if (!attr.name.startsWith("data-") || /^data-(react|next|astro|svelte|vue|v)-/i.test(attr.name)) {
        return false;
      }

      const nameToken = attr.name.slice(5);
      return isHumanToken(nameToken) && (attr.value === "" || isHumanToken(attr.value));
    }) || null;
  }

  function dataAttributeSelector(tag, attr) {
    return attr.value === "" ? `${tag}[${attr.name}]` : `${tag}[${attr.name}="${cssString(attr.value)}"]`;
  }

  function isAnnotatorElement(target) {
    return target instanceof Element && Boolean(target.closest(ANNOTATOR_CHROME_SELECTOR));
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

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }

        resolve(response);
      });
    });
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
    appendAnnotatorNode(dom.toast, activeAnnotatorHost(hoveredElement));
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

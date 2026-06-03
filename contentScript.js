(() => {
  if (window.__localUiAnnotatorLoaded) {
    return;
  }

  window.__localUiAnnotatorLoaded = true;

  const PAGE_PREFIX = "anny:page:";
  const SETTINGS_KEY = "anny:settings";
  const MAX_TEXT = 700;

  const defaultSettings = {
    markersVisible: true,
    animationsPaused: false,
    outputDetail: "standard"
  };

  const state = {
    annotations: [],
    feedbackEnabled: false,
    toolbarVisible: false,
    markersVisible: true,
    animationsPaused: false,
    outputDetail: "standard",
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
      renderToolbar();
      return ok();
    }

    if (message.type === "annotator:toggle-toolbar") {
      if (state.toolbarVisible) {
        closeToolbar();
      } else {
        state.toolbarVisible = true;
        renderToolbar();
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
      state.annotations = [];
      await saveAnnotations();
      closeComposer();
      renderMarkers();
      renderToolbar();
      return ok();
    }

    if (message.type === "annotator:set-detail") {
      state.outputDetail = ["compact", "standard", "detailed", "forensic"].includes(message.detail)
        ? message.detail
        : "standard";
      await saveSettings();
      renderToolbar();
      return ok();
    }

    if (message.type === "annotator:export") {
      return {
        ok: true,
        state: publicState(),
        markdown: formatMarkdown(state.annotations, state.outputDetail)
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
      outputDetail: state.outputDetail,
      url: location.href,
      title: document.title
    };
  }

  async function loadStateForPage() {
    currentPageKey = pageKey();
    const stored = await storageGet([currentPageKey, SETTINGS_KEY]);
    const page = stored[currentPageKey] || {};
    const settings = { ...defaultSettings, ...(stored[SETTINGS_KEY] || {}) };

    state.annotations = Array.isArray(page.annotations) ? page.annotations : [];
    state.markersVisible = settings.markersVisible;
    state.animationsPaused = settings.animationsPaused;
    state.outputDetail = settings.outputDetail;
    state.url = location.href;
  }

  async function saveAnnotations() {
    await storageSet({
      [currentPageKey]: {
        url: location.href,
        title: document.title,
        updatedAt: new Date().toISOString(),
        annotations: state.annotations
      }
    });
  }

  function saveSettings() {
    return storageSet({
      [SETTINGS_KEY]: {
        markersVisible: state.markersVisible,
        animationsPaused: state.animationsPaused,
        outputDetail: state.outputDetail
      }
    });
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
      state.annotations = [];
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

  function showComposer(element, clientX, clientY, existingAnnotation = null) {
    closeComposer();
    showTargetRing(element);

    const snapshot = existingAnnotation || collectElementContext(element, clientX, clientY);
    const composer = document.createElement("form");
    composer.className = "local-annotator-composer";
    composer.innerHTML = `
      <strong title="${escapeAttr(snapshot.elementPath)}">${escapeHtml(snapshot.elementSummary)}</strong>
      <textarea name="comment" placeholder="Describe the change you want the agent to make..." required>${escapeHtml(snapshot.comment || "")}</textarea>
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
        updatedAt: new Date().toISOString()
      };

      if (existingAnnotation) {
        state.annotations = state.annotations.map((annotation) =>
          annotation.id === existingAnnotation.id ? nextAnnotation : annotation
        );
      } else {
        state.annotations.push(nextAnnotation);
      }

      await saveAnnotations();
      closeComposer();
      renderMarkers();
      renderToolbar();
      toast(existingAnnotation ? "Annotation updated." : "Annotation added.");
    });

    composer.querySelector("[data-cancel]")?.addEventListener("click", closeComposer);
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
        <div class="local-annotator-detail" data-tooltip="Output detail">
          <select data-action="detail" aria-label="Output detail">
            ${detailOptions(state.outputDetail)}
          </select>
        </div>
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
          state.annotations = [];
          await saveAnnotations();
          renderMarkers();
          closeComposer();
          toast("Cleared annotations for this page.");
        }

        renderToolbar();
      });

      dom.toolbar.addEventListener("change", async (event) => {
        if (event.target instanceof HTMLSelectElement && event.target.dataset.action === "detail") {
          state.outputDetail = ["compact", "standard", "detailed", "forensic"].includes(event.target.value)
            ? event.target.value
            : "standard";
          await saveSettings();
          renderToolbar();
        }
      });

      const detailControl = dom.toolbar.querySelector(".local-annotator-detail");
      const detailSelect = dom.toolbar.querySelector('[data-action="detail"]');
      detailControl?.addEventListener("pointerdown", () => {
        detailControl.classList.add("is-tooltip-suppressed");
      });
      detailControl?.addEventListener("mouseleave", () => {
        detailControl.classList.remove("is-tooltip-suppressed");
      });
      detailSelect?.addEventListener("focus", () => {
        detailControl?.classList.add("is-tooltip-suppressed");
      });
    }

    const feedback = dom.toolbar.querySelector('[data-action="feedback"]');
    const markers = dom.toolbar.querySelector('[data-action="markers"]');
    const pause = dom.toolbar.querySelector('[data-action="pause"]');
    const count = dom.toolbar.querySelector("[data-count]");
    const detail = dom.toolbar.querySelector('[data-action="detail"]');

    feedback.classList.toggle("is-active", state.feedbackEnabled);
    markers.classList.toggle("is-active", state.markersVisible);
    pause.classList.toggle("is-active", state.animationsPaused);
    count.textContent = String(state.annotations.length);
    detail.value = state.outputDetail;
  }

  async function copyFromPage() {
    const markdown = formatMarkdown(state.annotations, state.outputDetail);
    if (!markdown) {
      toast("No annotations to copy.");
      return;
    }

    const copied = await writeClipboard(markdown);
    toast(copied ? `Copied ${state.annotations.length} annotation${state.annotations.length === 1 ? "" : "s"}.` : "Copy failed. Check clipboard permission and try again.");
  }

  function collectElementContext(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    const selector = getBestSelector(element);
    const fullPath = getFullPath(element);
    const react = detectReact(element);
    const attrs = relevantAttributes(element);
    const markerX = Math.round(window.scrollX + rect.left + Math.min(rect.width - 14, 10));
    const markerY = Math.round(window.scrollY + rect.top + Math.min(rect.height - 14, 10));

    return {
      id: `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      comment: "",
      elementPath: selector,
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
      computedStyles: styleObject(styles),
      computedStylesText: styleText(styles),
      isFixed: ["fixed", "sticky"].includes(styles.position),
      reactComponents: react.components,
      source: react.source
    };
  }

  function formatMarkdown(annotations, detail) {
    if (!annotations.length) {
      return "";
    }

    const title = document.title || "Untitled page";
    const url = location.href;
    const generatedAt = new Date().toISOString();
    const lines = [
      "# UI Feedback Annotations",
      "",
      "Use these annotations to update the implementation. Each item includes the target selector, page context, visual position, and reviewer feedback. Prefer changing the source component that owns the element; do not hard-code around the annotation metadata.",
      "",
      `- Page: ${title}`,
      `- URL: ${url}`,
      `- Generated: ${generatedAt}`,
      `- Output detail: ${detail}`,
      `- Annotation count: ${annotations.length}`,
      ""
    ];

    annotations.forEach((annotation, index) => {
      lines.push(`## Annotation #${index + 1}`);
      lines.push("");
      lines.push(`**Feedback:** ${annotation.comment}`);
      lines.push(`**Element:** ${annotation.elementSummary || annotation.element}`);
      lines.push(`**Selector:** \`${annotation.elementPath}\``);

      if (detail !== "compact") {
        lines.push(`**Full DOM path:** \`${annotation.fullPath}\``);
        if (annotation.cssClasses) {
          lines.push(`**Classes:** \`${annotation.cssClasses}\``);
        }
        if (annotation.reactComponents) {
          lines.push(`**React components:** ${annotation.reactComponents}`);
        }
        if (annotation.source) {
          lines.push(`**Source hint:** ${annotation.source}`);
        }
        lines.push(`**Position:** document (${annotation.boundingBox.x}px, ${annotation.boundingBox.y}px), viewport (${annotation.boundingBox.viewportX}px, ${annotation.boundingBox.viewportY}px), size ${annotation.boundingBox.width}x${annotation.boundingBox.height}px`);
      }

      if (["detailed", "forensic"].includes(detail)) {
        lines.push(`**URL at capture:** ${annotation.url}`);
        lines.push(`**Viewport:** ${annotation.viewport.width}x${annotation.viewport.height}, scroll ${annotation.viewport.scrollX}/${annotation.viewport.scrollY}, DPR ${annotation.viewport.devicePixelRatio}`);
        if (annotation.selectedText) {
          lines.push("**Selected text:**");
          lines.push(blockquote(annotation.selectedText));
        }
        if (annotation.nearbyText) {
          lines.push("**Visible text near target:**");
          lines.push(blockquote(annotation.nearbyText));
        }
        if (annotation.accessibility) {
          lines.push(`**Accessibility:** ${annotation.accessibility}`);
        }
        if (annotation.attributes?.length) {
          lines.push("**Relevant attributes:**");
          lines.push("```json");
          lines.push(JSON.stringify(annotation.attributes, null, 2));
          lines.push("```");
        }
        if (annotation.nearbyElements) {
          lines.push("**Nearby elements:**");
          lines.push("```text");
          lines.push(annotation.nearbyElements);
          lines.push("```");
        }
      }

      if (detail === "forensic") {
        lines.push("**Computed styles:**");
        lines.push("```css");
        lines.push(annotation.computedStylesText || "");
        lines.push("```");
        lines.push("**AFS-like JSON:**");
        lines.push("```json");
        lines.push(JSON.stringify(toPortableAnnotation(annotation), null, 2));
        lines.push("```");
      }

      lines.push("");
    });

    return lines.join("\n").trim() + "\n";
  }

  function toPortableAnnotation(annotation) {
    return {
      id: annotation.id,
      comment: annotation.comment,
      elementPath: annotation.elementPath,
      timestamp: annotation.timestamp,
      x: annotation.x,
      y: annotation.y,
      element: annotation.element,
      url: annotation.url,
      boundingBox: annotation.boundingBox,
      reactComponents: annotation.reactComponents || undefined,
      cssClasses: annotation.cssClasses || undefined,
      computedStyles: annotation.computedStylesText,
      accessibility: annotation.accessibility || undefined,
      nearbyText: annotation.nearbyText || undefined,
      selectedText: annotation.selectedText || undefined,
      isFixed: annotation.isFixed,
      fullPath: annotation.fullPath,
      nearbyElements: annotation.nearbyElements || undefined
    };
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
    if (!(element instanceof Element)) {
      return "";
    }

    const testId = firstAttribute(element, ["data-testid", "data-test-id", "data-cy", "data-qa"]);
    if (testId) {
      const selector = `${element.tagName.toLowerCase()}[${testId.name}="${cssString(testId.value)}"]`;
      if (isUnique(selector)) {
        return selector;
      }
    }

    if (element.id) {
      const selector = `${element.tagName.toLowerCase()}#${cssEscape(element.id)}`;
      if (isUnique(selector)) {
        return selector;
      }
    }

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
      return selector ? document.querySelector(selector) : null;
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

  function styleObject(styles) {
    return Object.fromEntries(styleProperties().map((property) => [property, styles.getPropertyValue(property)]));
  }

  function styleText(styles) {
    return styleProperties()
      .map((property) => `${property}: ${styles.getPropertyValue(property)};`)
      .join("\n");
  }

  function styleProperties() {
    return [
      "display",
      "position",
      "z-index",
      "box-sizing",
      "width",
      "height",
      "min-width",
      "min-height",
      "max-width",
      "max-height",
      "margin",
      "padding",
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "text-align",
      "border",
      "border-radius",
      "box-shadow",
      "opacity",
      "transform",
      "overflow",
      "object-fit",
      "justify-content",
      "align-items",
      "gap",
      "grid-template-columns",
      "flex-direction"
    ];
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

  function detailOptions(selected) {
    return [
      ["compact", "Compact"],
      ["standard", "Standard"],
      ["detailed", "Detailed"],
      ["forensic", "Forensic"]
    ]
      .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
      .join("");
  }

  function lucideIcon(name) {
    const attrs = 'class="local-annotator-lucide" viewBox="0 0 24 24" aria-hidden="true"';
    const icons = {
      crosshair: `<svg ${attrs}><circle cx="12" cy="12" r="10"></circle><line x1="22" x2="18" y1="12" y2="12"></line><line x1="6" x2="2" y1="12" y2="12"></line><line x1="12" x2="12" y1="6" y2="2"></line><line x1="12" x2="12" y1="22" y2="18"></line></svg>`,
      eye: `<svg ${attrs}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
      pause: `<svg ${attrs}><rect x="14" y="4" width="4" height="16" rx="1"></rect><rect x="6" y="4" width="4" height="16" rx="1"></rect></svg>`,
      copy: `<svg ${attrs}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`,
      "trash-2": `<svg ${attrs}><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" x2="10" y1="11" y2="17"></line><line x1="14" x2="14" y1="11" y2="17"></line></svg>`,
      x: `<svg ${attrs}><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`
    };

    return icons[name] || "";
  }

  function blockquote(text) {
    return normalizeWhitespace(text)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
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

  async function writeClipboard(text) {
    try {
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

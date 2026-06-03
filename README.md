# Anny

Anny is a local Chrome extension for annotating web interfaces and exporting structured implementation notes. It helps developers capture precise UI feedback by clicking directly on the element that needs attention, writing a note, and copying a markdown report with enough context for an engineer or AI coding assistant to act on it.

The name is short for "annotator."

## What it does

- Opens as a minimized toolbar in the bottom-right corner of the active page.
- Lets the user click a specific UI element and attach feedback to it.
- Adds numbered annotation markers directly on the page.
- Copies a structured markdown report with selector, DOM path, bounding box, viewport, nearby text, accessibility metadata, computed styles, and best-effort React/source hints when available.
- Supports Compact, Standard, Detailed, and Forensic output levels.
- Stores annotations locally with `chrome.storage.local`.
- Runs without a backend, account system, analytics, or network requests.

## Why

UI feedback often loses the most important part: exact context. A written note like "move this button" is ambiguous unless the implementer knows which button, where it lives in the DOM, what styles it has, and what surrounding UI state was visible.

Anny turns visual feedback into implementation-ready context. It is designed for local development, product reviews, and AI-assisted engineering workflows where precise element metadata saves time.

## Privacy and permissions

Anny is designed to be user-initiated:

- It does not use always-on content scripts.
- It injects its overlay only after the user clicks the extension icon.
- It does not send annotation data to any server.
- It stores page annotations locally in Chrome extension storage.
- It requests `activeTab`, `scripting`, `storage`, and `clipboardWrite` permissions for in-page annotation, local persistence, and copy-to-clipboard export.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the project folder.
5. Open any normal web page or local app, then click the Anny extension icon.

Chrome blocks extensions on internal pages such as `chrome://extensions` and `chrome://newtab`. For local `file://` pages, enable **Allow access to file URLs** on the extension details page.

## Use

- Click the extension icon to open the minimized toolbar.
- Click the extension icon again, press `Esc`, or click **Close** to dismiss it.
- Click **Annotate**, then click an element on the page.
- Add feedback for the selected element.
- Use **Copy** to copy markdown for implementation.
- Use **Markers** to hide or show marker bubbles.
- Use **Motion** to pause CSS animations and media while annotating.
- Use the output type field to choose Compact, Standard, Detailed, or Forensic before copying.
- Use **Clear** to remove annotations for the current page.

Keyboard shortcuts only work while the Anny toolbar is open:

- `Esc`: close the toolbar.
- `Cmd+Shift+F` / `Ctrl+Shift+F`: toggle annotation mode.
- `H`: hide/show markers.
- `P`: pause/resume motion.
- `C`: copy annotations.
- `X`: clear page annotations.

When the toolbar is closed, Anny does not capture page keyboard shortcuts.

## Output levels

- **Compact**: feedback, selector, and element summary.
- **Standard**: adds DOM path, classes, React/source hints when available, and bounding box.
- **Detailed**: adds selected text, nearby text, accessibility, attributes, nearby elements, and viewport.
- **Forensic**: adds computed CSS and a JSON payload.

## Limitations

- React component and source detection is best-effort and depends on development React internals being present.
- Browser security rules prevent annotation on Chrome internal pages.
- Cross-origin iframes are not annotated because the extension only injects into the top frame.
- Computed style export is intentionally scoped to useful layout and visual properties rather than every CSS property.

## Development

```bash
npm run validate
```

The validation script checks required extension files, Manifest V3 shape, public-safety constraints, and JavaScript parseability.

## License

All rights reserved. This repository is public for portfolio and code review purposes only. Reuse, redistribution, sublicensing, or modification requires written permission from the repository owner.

# Anny

Anny is a local Chrome extension for annotating web interfaces and exporting structured implementation notes. It helps developers capture precise UI feedback by clicking directly on the element that needs attention, writing a note, and copying a markdown report with enough context for an engineer or AI coding assistant to act on it.

The name is short for "annotator."

## What it does

- Opens as a minimized toolbar in the bottom-right corner of the active page.
- Uses a custom Anny extension icon in Chrome.
- Lets the user click a specific UI element and attach feedback to it.
- Adds numbered annotation markers directly on the page.
- Copies a lean agent-ready markdown report with a source URL, DOM base hash, robust anchors, structural DOM paths, target hashes, scope, optional structured reference context, style/box context, and cropped screenshot data when available.
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
- In the Reference field, use **Pick** to start a reference picker. Navigate normally to the reference UI, click **Capture**, then click the reference element; Anny saves it back to the original annotation.
- Use **Copy** to copy lean markdown for implementation.
- Use **Markers** to hide or show marker bubbles.
- Use **Motion** to pause CSS animations and media while annotating.
- Use **Clear** and confirm **Clear?** to remove annotations for the current page.

Keyboard shortcuts only work while the Anny toolbar is open:

- `Esc`: close the toolbar.
- `Cmd+Shift+F` / `Ctrl+Shift+F`: toggle annotation mode.
- `H`: hide/show markers.
- `P`: pause/resume motion.
- `C`: copy annotations.
- `X`: clear page annotations.

When the toolbar is closed, Anny does not capture page keyboard shortcuts.

## Export

Anny exports one agent-ready Markdown prompt. It includes the compatibility `intent`, split `observation` and `desiredState`, change type, cascade flag, human target locator, robust anchor, structural DOM path, target hash, nearby text, full target HTML snippet, role/ARIA when present, scope, reference pattern/example when present, box/style context, and screenshot data or explicit failure notes. Screenshot capture is automatic; when Chrome cannot provide a crop, the export says so explicitly.

## Limitations

- React component and source detection is best-effort and depends on development React internals being present.
- Browser security rules prevent annotation on Chrome internal pages.
- Cross-origin iframes are not annotated because the extension only injects into the top frame.

## Development

```bash
npm run validate
```

The validation script checks required extension files, Manifest V3 shape, public-safety constraints, and JavaScript parseability.

## License

All rights reserved. This repository is public for portfolio and code review purposes only. Reuse, redistribution, sublicensing, or modification requires written permission from the repository owner.

# AGENTS.md

## Project Overview

Anny is a local Manifest V3 Chrome extension for annotating web interfaces and copying implementation-ready UI feedback. The user opens the extension on the active page, clicks a page element, writes feedback, and copies a Markdown prompt that gives an engineer or AI coding assistant enough element context to implement the requested changes.

The name Anny is short for annotator.

Anny is a portfolio/public-repo project, but it is designed as a personal local tool. Keep the repository sanitized and public-safe.

## Product Behavior

- Clicking the Chrome extension icon opens the minimized toolbar in the bottom-right corner of the active page.
- Opening from a closed state should put Anny directly into annotation mode.
- Clicking the extension icon again, pressing `Esc`, or clicking the close button dismisses the UI.
- The toolbar is the primary UI. Do not add a default popup or a large top-mounted panel.
- The user can annotate elements, show or hide numbered markers, pause page motion, copy annotations, clear page annotations, and close the toolbar.
- Keyboard shortcuts are page-scoped and must only work while the Anny toolbar is open. When the toolbar is closed, Anny must not intercept normal page shortcuts.
- Annotation data is stored locally with `chrome.storage.local`.

## UI Rules

- Use neutral colors throughout the extension UI.
- Use blue as the primary accent only where neutral colors are hard to see, such as annotation markers placed over the inspected page.
- Use the regular Geist font everywhere in Anny UI.
- Use Lucide-style icons for all icon buttons.
- Tooltip text should be short action names only, such as `Annotate`, `Markers`, `Pause motion`, `Copy`, `Clear`, and `Close`.
- Keep the minimized toolbar compact and readable. Tooltips should appear quickly and only while hovering, not after clicking.
- Do not reintroduce Intent or Severity fields.
- Do not reintroduce verbose output-detail controls unless explicitly requested.

## Architecture

- `manifest.json` defines the MV3 extension, icon assets, permissions, and web-accessible Geist font.
- `background.js` handles `chrome.action.onClicked`, injects the extension into the current active tab, and sends `annotator:toggle-toolbar`.
- `contentScript.js` owns toolbar state, annotation state, element metadata collection, local persistence, clipboard export, keyboard handling, and page overlays.
- `contentStyles.css` owns all injected UI styling.
- `icons/` contains the generated Anny icon and Chrome icon sizes.
- `fonts/Geist-Regular.woff2` is the vendored UI font.
- `scripts/validate-extension.js` is the release guardrail for manifest, asset, privacy, and parseability checks.

## Privacy And Permission Boundaries

- Do not add a backend, account system, analytics, telemetry, or network requests.
- Do not request `host_permissions`.
- Do not add always-on `content_scripts`.
- Do not add browser-level `manifest.commands`.
- Keep injection user-initiated through `activeTab` and `scripting` after the user clicks the extension icon.
- Keep annotation data local to Chrome extension storage and clipboard operations.
- Do not include private local paths, private project names, private customer data, or third-party clone language in public docs.

## Export Contract

Anny exports one lean agent-ready Markdown prompt. The export should include:

- The user-written intent for each annotation.
- The source page URL and DOM base hash.
- A human-readable target locator and robust anchor.
- Nearby or selected text when available.
- Role and ARIA context when available.
- Scope and optional reference field when present.
- Screenshot attachment notes, including explicit failure notes when Chrome cannot capture a crop.

The export should be useful even when screenshots are unavailable. Do not make implementation depend on screenshots being present.

## Development And Validation

Run these before considering a change complete:

```bash
npm run validate
git diff --check -- .
```

`npm run validate` checks required files, Manifest V3 shape, icon assets, public-safety constraints, removed verbose export support, toolbar behavior markers, gated keyboard shortcuts, and JavaScript parseability.

## Public Repo Notes

The public repository is intended for portfolio and code review use. The license is All Rights Reserved, so do not imply open-source reuse rights unless the license changes.

When editing, keep changes small and aligned with the current extension architecture. Inspect `git status` and relevant diffs first, because local changes may exist that should not be reverted or staged accidentally.

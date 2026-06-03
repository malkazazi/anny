const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "manifest.json",
  "background.js",
  "fonts/Geist-Regular.woff2",
  "icons/anny-icon.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "contentScript.js",
  "contentStyles.css",
  "README.md"
];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json must use manifest_version 3");
}

if (manifest.action?.default_popup) {
  throw new Error("manifest action should not define default_popup; clicking the icon must open the in-page toolbar");
}

if (manifest.host_permissions || manifest.content_scripts) {
  throw new Error("manifest.json should not request host_permissions or always-on content_scripts; Anny injects only after the user clicks the extension");
}

if (manifest.commands) {
  throw new Error("manifest.json should not define browser-level keyboard commands; shortcuts must be page-scoped and toolbar-gated");
}

const expectedIcons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
};

for (const [size, iconPath] of Object.entries(expectedIcons)) {
  if (manifest.icons?.[size] !== iconPath) {
    throw new Error(`manifest.json must define icons.${size} as ${iconPath}`);
  }

  if (manifest.action?.default_icon?.[size] !== iconPath) {
    throw new Error(`manifest.json must define action.default_icon.${size} as ${iconPath}`);
  }

  const dimensions = readPngDimensions(path.join(root, iconPath));
  if (dimensions.width !== Number(size) || dimensions.height !== Number(size)) {
    throw new Error(`${iconPath} must be ${size}x${size}px, found ${dimensions.width}x${dimensions.height}px`);
  }
}

const webResources = JSON.stringify(manifest.web_accessible_resources || []);
if (!webResources.includes("fonts/Geist-Regular.woff2")) {
  throw new Error("manifest.json must expose the vendored Geist font to content styles");
}

for (const file of ["background.js", "contentScript.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  new vm.Script(source, { filename: file });
}

const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
if (!backgroundSource.includes("chrome.action.onClicked") || !backgroundSource.includes("annotator:toggle-toolbar")) {
  throw new Error("background.js must toggle the in-page toolbar from the extension icon");
}

if (backgroundSource.includes("chrome.commands")) {
  throw new Error("background.js should not register global Chrome keyboard commands");
}

const contentSource = fs.readFileSync(path.join(root, "contentScript.js"), "utf8");
for (const required of ["annotator:toggle-toolbar", "data-action=\"close\"", "data-tooltip", "formatAgentMarkdown", "formatMarkdown", "captureElementShot(snapshot)"]) {
  if (!contentSource.includes(required)) {
    throw new Error(`contentScript.js is missing toolbar support: ${required}`);
  }
}

for (const removed of ["format" + "For" + "ensicMarkdown", "mode" + "Options", "computed" + "StylesText", "AFS-like" + " JSON", "data-action=\"settings\"", "batch" + "Goal", "include" + "Screenshots", "name=\"des" + "ired\"", "name=\"gr" + "oup\""]) {
  if (contentSource.includes(removed)) {
    throw new Error(`contentScript.js should not include removed verbose export support: ${removed}`);
  }
}

if (!contentSource.includes("if (!state.toolbarVisible)")) {
  throw new Error("contentScript.js keyboard shortcuts must be gated by toolbar visibility");
}

for (const verboseTooltip of ["Annotate:", "Markers:", "Pause motion:", "Copy:", "Clear:", "Close:"]) {
  if (contentSource.includes(verboseTooltip)) {
    throw new Error(`contentScript.js should use action-name-only tooltip text, found ${verboseTooltip}`);
  }
}

console.log("Extension validation passed.");

function readPngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error(`${path.relative(root, filePath)} is not a PNG file`);
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

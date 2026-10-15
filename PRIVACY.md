# Privacy Policy for Self-Hub Chrome Extension

Last updated: October 15, 2026

Self-Hub ("we", "our", or "the extension") is a local-first productivity tool designed to provide native web page text highlighting, annotation, and a minimal new tab dashboard.

We strongly value your privacy. This Privacy Policy explains our practices regarding user data.

---

### 1. Data Collection and Usage

**Self-Hub does not collect, transmit, sell, or monetize any of your personal data.**

All features operate strictly under the **Local-First** design principle:
- **Website Content (Highlights & Notes)**: When you highlight text or write thought annotations on a webpage, this text and the associated page URL/title are saved exclusively in your browser's local storage (`chrome.storage.local`). This data never leaves your device.
- **Bookmarks & Quick Scratchpad**: Notes and bookmarks entered in the new tab page remain 100% within your local device memory and storage.
- **No Analytics / No Tracking**: Self-Hub contains no third-party trackers, telemetry, analytics SDKs, advertising scripts, or external tracking pixels.
- **No Remote Code**: The extension executes solely packaged, audited code contained directly within the extension package.

---

### 2. Permissions Justification

Self-Hub requests only the minimum set of permissions necessary to deliver its core features:
- `activeTab`: Used to capture selected text and page metadata on the currently active tab when you trigger highlights or save items.
- `storage`: Used to persist your annotations, color settings, and scratchpad notes locally on your device.
- `sidePanel`: Used to display your annotations in Chrome's native side panel for search and Markdown export.
- `scripting`: Used to apply non-destructive CSS highlight styling to your selected text.
- `contextMenus`: Used to provide convenient right-click shortcuts ("Highlight selected text" and "Save to inbox").
- `Host Permissions` (`http://*/*`, `https://*/*`): Required exclusively to allow the content script to inject highlight marks on arbitrary websites you choose to browse and annotate.

---

### 3. Data Storage & Security

- All user data is stored strictly locally using Chrome's built-in secure storage API (`chrome.storage.local`).
- We do not operate external databases, remote user tracking servers, or analytics endpoints.
- If you uninstall the extension, all locally stored data within the extension's storage sandbox is permanently deleted by Chrome.

---

### 4. Third-Party Sharing

We do **not** sell, rent, trade, or transfer any user data to third parties. We do not use user data for creditworthiness, lending, or behavioral profiling purposes.

---

### 5. Changes to This Policy

If we update this Privacy Policy in the future, revisions will be published on this repository page.

---

### 6. Contact

If you have questions or inquiries regarding this Privacy Policy, please open an issue on our GitHub repository:
https://github.com/GameSheep/self

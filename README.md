AI Chat Knowledge Organizer (Chrome Extension)

This repository contains a Chrome extension that captures and organizes AI chat messages, provides a sidebar UI, and supports quick navigation back to source messages.

Features
- In-page side panel with saved conversations
- Search and highlight source messages
- Theme-aware UI and customizable panel accent color
- KaTeX/MathJax sanitizer to avoid glyph rendering errors

Build

1. Install dependencies:

```powershell
npm install
```

2. Build the extension (TypeScript -> JS):

```powershell
npm run build
```

3. (Optional) Generate icon PNGs from `src/icons/logoextension1.png`:

```powershell
npm run generate-icons
```

Packaging & publishing

- The repository includes a GitHub Actions workflow to package the extension into a ZIP and create a GitHub Release when you push a tag or trigger the workflow manually.
- To publish to the Chrome Web Store automatically, configure the required secrets (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, WEBSTORE_ITEM_ID) in your repository settings and enable the optional publish step in the workflow.

See `./.github/workflows/package-and-release.yml` for details.

License

This project is provided under the MIT License — see `LICENSE`.

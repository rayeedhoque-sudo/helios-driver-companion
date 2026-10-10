# BLine Web (vendored build)

Prebuilt copy of the BLine path editor for the companion's "Path Planner" tab.
Vendored (not loaded from bline-web.pages.dev) because the competition field has no internet.

- Source: https://github.com/edanliahovetsky/BLine-Web @ ab79fa3 (v0.1.0-alpha.12), BSD-3 (see LICENSE)
- Rebuilt with: `npm ci && npx vite build --base ./` then copy `dist/` here. `--base ./` is required
  so the asset paths resolve from file:// inside Electron.
- Local patch after building: the built-in field images are hardcoded as `/assets/fields/...`
  (src/core/field/fieldConfig.ts), which resolves to the drive root under file://. Rewritten to
  `./assets/fields/...` in `assets/index-*.js`:
  `sed -i 's#image_src:\`/assets/fields/#image_src:\`./assets/fields/#g' assets/index-*.js`

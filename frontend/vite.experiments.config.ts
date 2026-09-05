import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "preview-index",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const html = bundle["experiments.html"];
        if (html) {
          html.fileName = "index.html";
          bundle["index.html"] = html;
          delete bundle["experiments.html"];
        }
      },
    },
  }],
  build: {
    // Design studies must never replace the build served by the daily app.
    outDir: "../output/playwright/ui-preview/dist",
    emptyOutDir: true,
    rollupOptions: { input: "experiments.html" },
  },
});

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        website: "index.html",
        dashboard: "dashboard.html",
        privacy: "privacy.html",
        terms: "terms.html",
      },
    },
  },
});

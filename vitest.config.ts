import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Kept apart from `vite.config.ts` so the federation plugin is not part of the
 * tests: the view is tested as the component it is, rendered into a DOM.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // The conformance test loads the bundle the package ships, so it is built
    // first rather than trusted to be current.
    globalSetup: ["test/build-bundle.ts"],
  },
});

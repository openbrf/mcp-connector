import { federation } from "@module-federation/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * A chunk's name, cut short and in the characters the catalog's reader takes
 * in a path segment: a letter or digit first, then letters, digits, `.`, `_`
 * and `-`.
 */
function shortName(name: string): string {
  const cut = name
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40);
  return cut === "" ? "chunk" : cut;
}

/**
 * The view's build: a Module Federation 2.0 remote the host loads at runtime,
 * as `openbrf/example-plugin` builds its own.
 *
 * The remote's name is the plugin id and the exposed module is the manifest's
 * `view.module`. React, ReactDOM, react-i18next and i18next are shared
 * singletons, the four the host shares: a second copy would give the view its
 * own hook dispatcher, or a resource store the connector's translations were
 * never merged into. `requiredVersion: false` because the connector is
 * installed into a host whose exact versions it was not built against.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "mcp-connector",
      filename: "remoteEntry.js",
      exposes: { "./View": "./src/View.tsx" },
      shared: {
        react: { singleton: true, requiredVersion: false },
        "react-dom": { singleton: true, requiredVersion: false },
        "react-i18next": { singleton: true, requiredVersion: false },
        i18next: { singleton: true, requiredVersion: false },
      },
      // The host loads the remote from its manifest at runtime, so a type
      // archive would only be dead weight in the tarball.
      dts: false,
    }),
  ],
  build: {
    target: "esnext",
    outDir: "dist",
    // The view is built first and owns the directory while it runs; the
    // server bundle is then written beside it.
    emptyOutDir: true,
    // The remote entry, which the federation plugin emits, is the only entry
    // point. Left unset, Vite would look for an index.html.
    rollupOptions: {
      input: {},
      output: {
        // The federation plugin names its chunks after virtual module ids that
        // start with an underscore and run past 100 characters, and the
        // catalog's strict tarball reader refuses both.
        chunkFileNames: (chunk) => `assets/${shortName(chunk.name)}-[hash].js`,
        assetFileNames: (asset) =>
          `assets/${shortName(asset.names[0] ?? "asset")}-[hash][extname]`,
      },
    },
  },
});

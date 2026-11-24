/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  test: {
    // Hosted macOS runners are 5-10x slower than local machines.
    testTimeout: 20_000,
    setupFiles: ["./src/test/setup.ts"],
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser talks to /api; Vite forwards it to the API so no CORS setup is needed.
    proxy: { "/api": { target: "http://localhost:4000", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});

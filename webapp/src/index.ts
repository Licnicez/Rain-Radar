import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    "/manifest.json": () =>
      new Response(Bun.file("./src/manifest.json"), {
        headers: { "Content-Type": "application/manifest+json" },
      }),

    "/sw.js": () =>
      new Response(Bun.file("./src/sw.js"), {
        headers: { "Content-Type": "application/javascript" },
      }),

    "/icon.svg": () =>
      new Response(Bun.file("./src/icon.svg"), {
        headers: { "Content-Type": "image/svg+xml" },
      }),

    "/icon-192.png": () =>
      new Response(Bun.file("./src/icon-192.png"), {
        headers: { "Content-Type": "image/png" },
      }),

    "/icon-512.png": () =>
      new Response(Bun.file("./src/icon-512.png"), {
        headers: { "Content-Type": "image/png" },
      }),

    // API Test Endpoints
    "/api/hello": {
      async GET() {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
    },

    // Serve index.html for all other routes
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,
    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);


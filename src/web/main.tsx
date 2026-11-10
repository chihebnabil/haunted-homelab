import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted variable fonts: bundled by Vite, so no request leaves for a font CDN.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/cinzel";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) throw new Error('Missing application root element "#root"');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Fonts are bundled locally through styles/fonts.css (imported by nexum.css): no network fonts.
import "./styles/nexum.css";
import App from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Nexum: #root element not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

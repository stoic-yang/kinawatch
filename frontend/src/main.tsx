import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./experiments/shared.css";
import "./experiments/themes/grove.css";
import { Journal } from "./experiments/concepts/Journal";
import { initializePalette } from "./experiments/concepts/palettes";
import "./experiments/concepts/component-system.css";

document.documentElement.dataset.previewTheme = "grove";
document.documentElement.dataset.concept = "journal";
initializePalette();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App renderShell={props => <Journal {...props} />} />
  </StrictMode>,
);

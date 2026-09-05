import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import "../styles.css";
import "./shared.css";
import { THEMES } from "./types";
import { Paper } from "./themes/Paper";
import { Orbit } from "./themes/Orbit";
import { Grove } from "./themes/Grove";
import { Studio } from "./themes/Studio";
import { Tide } from "./themes/Tide";

const theme = THEMES.find((item) => item.port === Number(window.location.port)) ?? THEMES[0];
const Shell = { paper: Paper, orbit: Orbit, grove: Grove, studio: Studio, tide: Tide }[theme.id];
document.documentElement.dataset.previewTheme = theme.id;
document.documentElement.style.colorScheme = theme.id === "orbit" ? "dark" : "light";
document.title = `KinaWatch · ${theme.name} ${theme.english}`;

createRoot(document.getElementById("root")!).render(
  <StrictMode><App renderShell={(props) => <Shell {...props} />} /></StrictMode>,
);

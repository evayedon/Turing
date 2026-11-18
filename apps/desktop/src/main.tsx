import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@turing/design-system/nebula.css";
import { Workbench } from "./shell/Workbench";
import "./shell/workbench.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);

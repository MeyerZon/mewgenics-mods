// Mewgenics mod editor — browser UI entry (React 19, built by Vite). Talks to the local
// server's /api bridge, which routes to the shared core.

import React from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("app")!).render(<App />);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { initAuth } from "./auth";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
initAuth()
  .then(() =>
    root.render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    ),
  )
  .catch((err) => root.render(<p style={{ padding: 24 }}>Could not start: {String(err)}</p>));

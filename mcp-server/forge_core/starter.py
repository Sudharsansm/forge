"""Files added to the downloaded .zip so the project runs on its own (`npm install && npm run dev`).

They are generated here on export only; they are never stored or shown in the window. While you work in Forge the app is
compiled inside the window, so none of this is needed."""
from __future__ import annotations

import json

DEPENDENCIES = {
    "react": "^19.0.0", "react-dom": "^19.0.0", "react-router-dom": "^7.0.0", "lucide-react": "^0.468.0",
    "recharts": "^2.15.0", "clsx": "^2.1.1", "framer-motion": "^11.15.0", "tailwindcss": "^4.0.0", "@tailwindcss/vite": "^4.0.0",
}
DEV_DEPENDENCIES = {"@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^4.3.4", "typescript": "~5.7.0", "vite": "^6.0.0"}


def starter_files(project: str, existing: set[str]) -> dict[str, str]:
    app = next((p for p in ("src/App.tsx", "src/App.jsx", "src/App.ts", "src/App.js") if p in existing), "src/App.tsx")
    app_import = "./" + app.removeprefix("src/").rsplit(".", 1)[0]
    out = {
        "package.json": json.dumps({"name": project, "private": True, "version": "0.0.0", "type": "module",
                                    "scripts": {"dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview"},
                                    "dependencies": DEPENDENCIES, "devDependencies": DEV_DEPENDENCIES}, indent=2) + "\n",
        "vite.config.ts": 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport tailwindcss from "@tailwindcss/vite";\n\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n',
        "tsconfig.json": json.dumps({"compilerOptions": {"target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
                                                          "moduleResolution": "bundler", "jsx": "react-jsx", "strict": True, "skipLibCheck": True,
                                                          "noEmit": True, "allowImportingTsExtensions": True}, "include": ["src"]}, indent=2) + "\n",
        "index.html": f'<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>{project}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
        "src/main.tsx": f"import {{ StrictMode }} from 'react'\nimport {{ createRoot }} from 'react-dom/client'\nimport './index.css'\nimport App from '{app_import}'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n",
        "src/index.css": '@import "tailwindcss";\n',
        ".gitignore": "node_modules\ndist\n",
    }
    return {k: v for k, v in out.items() if k not in existing}

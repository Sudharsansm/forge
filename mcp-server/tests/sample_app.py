"""A small but realistic Vite + React project used by the analyzer, diagram and library tests."""

SAMPLE = {
    "package.json": '{"name":"demo","dependencies":{"react":"^19","react-dom":"^19","react-router-dom":"^7"},"devDependencies":{"vite":"^7"}}',
    "index.html": '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    "src/main.tsx": (
        'import { createRoot } from "react-dom/client";\nimport { HashRouter } from "react-router-dom";\nimport App from "./App";\n'
        'import "./index.css";\ncreateRoot(document.getElementById("root")!).render(<HashRouter><App /></HashRouter>);\n'),
    "src/index.css": "@import 'tailwindcss';\n",
    "src/App.tsx": (
        'import { Routes, Route, Link } from "react-router-dom";\nimport Home from "./pages/Home";\nimport About from "./pages/About";\n'
        'import { ThemeProvider } from "./context/theme";\n\nexport default function App() {\n  return (\n    <ThemeProvider>\n'
        '      <nav><Link to="/about">About us</Link></nav>\n      <Routes>\n        <Route path="/" element={<Home />} />\n'
        '        <Route path="/about" element={<About />} />\n      </Routes>\n    </ThemeProvider>\n  );\n}\n'),
    "src/context/theme.tsx": (
        'import { createContext, useContext, useState } from "react";\nexport const ThemeCtx = createContext("light");\n'
        'export function ThemeProvider({ children }: { children: React.ReactNode }) {\n  const [theme] = useState("light");\n'
        '  return <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>;\n}\n'),
    "src/pages/Home.tsx": (
        'import { useState, useEffect } from "react";\nimport Card from "../components/Card";\nimport { items } from "../data/items";\n\n'
        'export default function Home() {\n  const [count, setCount] = useState(0);\n  useEffect(() => {\n    fetch("/api/items").then((r) => r.json());\n'
        '    const t = setInterval(() => {}, 1000);\n    return () => clearInterval(t);\n  }, []);\n  function inc() {\n    setCount(count + 1);\n  }\n'
        '  return (\n    <div>\n      <button onClick={inc}>Add one</button>\n      <Card title="Items" items={items} />\n    </div>\n  );\n}\n'),
    "src/pages/About.tsx": (
        'import { useNavigate } from "react-router-dom";\nexport default function About() {\n  const navigate = useNavigate();\n'
        '  return <button onClick={() => navigate("/")}>Back home</button>;\n}\n'),
    "src/components/Card.tsx": (
        'export default function Card({ title, items }: { title: string; items: string[] }) {\n'
        '  return <section><h2>{title}</h2><ul>{items.map((i) => <li key={i}>{i}</li>)}</ul></section>;\n}\n'),
    "src/components/Unused.tsx": "export default function Unused() { return <div>never used</div>; }\n",
    "src/data/items.ts": 'export const items = ["a", "b", "c"];\n',
    "src/utils/a.ts": 'import { b } from "./b";\nexport const a = () => b();\n',
    "src/utils/b.ts": 'import { a } from "./a";\nimport missing from "./nope";\nimport lodash from "lodash";\nexport const b = () => a() + missing + lodash;\n',
}

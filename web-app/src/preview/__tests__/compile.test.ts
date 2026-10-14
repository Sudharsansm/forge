import { describe, expect, it } from "vitest";
import { compileProject, tagSource } from "../compile";

describe("compileProject", () => {
  it("compiles a simple app", () => {
    const r = compileProject({ "src/App.tsx": "export default function App(){return <h1 className='p-4'>Hi</h1>}" });
    expect(r.ok).toBe(true);
    expect(r.html).toContain("data-forge-src");
  });
  it("resolves relative imports and css-free components", () => {
    const r = compileProject({
      "src/App.tsx": "import B from './B';export default function App(){return <B/>}",
      "src/B.tsx": "export default function B(){return <p>b</p>}",
    });
    expect(r.ok).toBe(true);
  });
  it("accepts bundled packages", () => {
    const r = compileProject({ "src/App.tsx": "import {Home} from 'lucide-react';import clsx from 'clsx';export default function App(){return <Home className={clsx('a')}/>}" });
    expect(r.ok).toBe(true);
  });
  it("unknown packages compile but fail at run time with a clear message", () => {
    const r = compileProject({ "src/App.tsx": "import x from 'lodash';export default function App(){return <p>{String(x)}</p>}" });
    expect(r.ok).toBe(true);
    expect(r.html).toContain("is not available in the Forge preview");
  });
  it("reports syntax errors", () => {
    const r = compileProject({ "src/App.tsx": "export default function App(){return <div>}" });
    expect(r.ok).toBe(false);
  });
  it("asks for an App when missing", () => {
    expect(compileProject({}).ok).toBe(false);
    expect(compileProject({ "src/x.ts": "export const a=1" }).error).toMatch(/App\.tsx/);
  });
  it("tags JSX elements with file:line:col", () => {
    expect(tagSource("const a = <div>x</div>;", "src/A.tsx")).toContain('data-forge-src="src/A.tsx:1:');
  });
});

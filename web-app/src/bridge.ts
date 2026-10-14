/**
 * One interface, two transports:
 *  - "mcp":        running inside an MCP host (Claude, ChatGPT, VS Code...): uses the official MCP Apps SDK.
 *  - "standalone": opened directly in a browser: talks to the Forge server's REST mirror of the same tools.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { APP_VERSION } from "./version";

export type ToolInput = Record<string, unknown> | undefined;
export type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };
export type Handlers = {
  onToolInput: (args: ToolInput) => void;
  onToolInputPartial: (args: ToolInput) => void;
  onToolResult: (result: ToolResult) => void;
  onTheme: (theme: "light" | "dark" | undefined) => void;
  onDisplayMode: (mode: string | undefined) => void;
};
export type DownloadFile = { filename: string; mimeType: string; base64: string };
export type PromptImage = { mimeType: string; base64: string };
export type PromptContext = { instruction: string; path: string; line: number; col: number };

export interface Bridge {
  kind: "mcp" | "standalone";
  aiEdit: boolean; // standalone only: server can call the Claude API itself
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  sendPrompt(text: string, ctx?: PromptContext, images?: PromptImage[]): Promise<"sent" | "copied">;
  setContext(text: string): Promise<void>;
  download(file: DownloadFile): Promise<void>;
  setFullscreen(on: boolean): Promise<string | undefined>;
  openLink(url: string): Promise<void>;
  canFullscreen: boolean;
  project?: string;
}

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("") : "";

export function inHost(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

export async function createBridge(h: Handlers): Promise<Bridge> {
  return inHost() ? mcpBridge(h) : standaloneBridge(h);
}

async function mcpBridge(h: Handlers): Promise<Bridge> {
  const app = new App({ name: "forge-workbench", version: APP_VERSION }, { availableDisplayModes: ["inline", "fullscreen"] });
  app.ontoolinput = (p) => h.onToolInput(p.arguments);
  app.ontoolinputpartial = (p) => h.onToolInputPartial(p.arguments);
  app.ontoolresult = (r) => h.onToolResult(r as ToolResult);
  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme) h.onTheme(ctx.theme);
    if (ctx.displayMode) h.onDisplayMode(ctx.displayMode);
  };
  await app.connect();
  const ctx = app.getHostContext();
  h.onTheme(ctx?.theme);
  h.onDisplayMode(ctx?.displayMode);
  const modes = ctx?.availableDisplayModes ?? [];

  return {
    kind: "mcp",
    aiEdit: false,
    canFullscreen: modes.includes("fullscreen"),
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const r = await app.callServerTool({ name, arguments: args });
      if (r.isError) throw new Error(textOf(r.content) || `${name} failed`);
      return (r.structuredContent ?? {}) as T;
    },
    async sendPrompt(text, _ctx, images) {
      if (images?.length) { // the drawn marks as a picture; a host that cannot take images gets the text alone
        const withImg = await app.sendMessage({ role: "user", content: [{ type: "text", text }, ...images.map((i) => ({ type: "image" as const, data: i.base64, mimeType: i.mimeType }))] }).catch(() => null);
        if (withImg && !withImg.isError) return "sent";
      }
      const r = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      if (r.isError) throw new Error("The host did not accept the message");
      return "sent";
    },
    async setContext(text) {
      await app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
    },
    async download(file) {
      const r = await app.downloadFile({
        contents: [{ type: "resource", resource: { uri: `file:///${file.filename}`, mimeType: file.mimeType, blob: file.base64 } }],
      });
      if (r.isError) throw new Error("Download was cancelled or denied by the host");
    },
    async setFullscreen(on) {
      const r = await app.requestDisplayMode({ mode: on ? "fullscreen" : "inline" });
      return r.mode;
    },
    async openLink(url) {
      const r = await app.openLink({ url });
      if (r.isError) throw new Error("The host did not open the link");
    },
  };
}

async function standaloneBridge(_h: Handlers): Promise<Bridge> {
  const token = new URLSearchParams(location.search).get("token") ?? sessionStorageGet("forge_key") ?? "";
  const headers = (): HeadersInit => ({ "Content-Type": "application/json", ...(token ? { "X-API-Key": token } : {}) });
  const health = await fetch("/api/health", { headers: headers() }).then((r) => r.json()).catch(() => ({ ai: false }));
  const project = new URLSearchParams(location.search).get("project") ?? "default";

  return {
    kind: "standalone",
    aiEdit: Boolean((health as { ai?: boolean }).ai),
    canFullscreen: false,
    project,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const r = await fetch(`/api/tool/${name}`, { method: "POST", headers: headers(), body: JSON.stringify(args) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(String((data as { error?: string }).error ?? r.statusText));
      return data as T;
    },
    async sendPrompt(text, ctx) {
      if (ctx && (health as { ai?: boolean }).ai) {
        const r = await fetch("/api/ai/edit", { method: "POST", headers: headers(), body: JSON.stringify({ project, ...ctx }) });
        if (!r.ok) throw new Error(String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText));
        return "sent";
      }
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      return "copied";
    },
    async setContext() {},
    async download(file) {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      const a = Object.assign(document.createElement("a"), { href: url, download: file.filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    async setFullscreen() {
      return undefined;
    },
    async openLink(url) {
      window.open(url, "_blank", "noopener");
    },
  };
}

function sessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

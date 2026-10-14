// A minimal MCP *host*, built on the official SDK's AppBridge, used to test the workbench end to end.
// It connects to a Forge server over Streamable HTTP, reads the ui:// resource, renders it in a sandboxed iframe under
// the spec's DEFAULT CSP, and records everything the app asks of its host (messages, context, downloads, display mode).
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const SERVER = new URLSearchParams(location.search).get("server") ?? "http://127.0.0.1:8000";
const DEFAULT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rec = {
  tools: unknown[]; resourceMeta: unknown; initialized: boolean; messages: unknown[]; contexts: unknown[]; downloads: unknown[];
  displayModes: string[]; links: unknown[]; appToolCalls: string[]; ready: boolean;
  run: (name: string, args: Record<string, unknown>, partials?: Record<string, unknown>[]) => Promise<unknown>;
  setTheme: (t: "light" | "dark") => Promise<void>;
};
const rec: Rec = { tools: [], resourceMeta: null, initialized: false, messages: [], contexts: [], downloads: [], displayModes: [], links: [], appToolCalls: [], ready: false,
  run: async () => ({}), setTheme: async () => {} };
(window as unknown as { __host: Rec }).__host = rec;

async function main() {
  const client = new Client({ name: "forge-test-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(SERVER + "/mcp")));
  rec.tools = (await client.listTools()).tools.map((t) => ({ name: t.name, ui: (t._meta as { ui?: unknown } | undefined)?.ui }));
  const res = await client.readResource({ uri: "ui://forge/workbench" });
  const content = res.contents[0] as { text?: string; mimeType?: string; _meta?: unknown };
  rec.resourceMeta = { mimeType: content.mimeType, meta: content._meta };
  const html = (content.text ?? "").replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${DEFAULT_CSP}">`);

  const iframe = document.createElement("iframe");
  iframe.id = "view";
  iframe.setAttribute("sandbox", "allow-scripts");
  document.body.appendChild(iframe);

  const bridge = new AppBridge(client, { name: "forge-test-host", version: "1.0.0" }, { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
    { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], containerDimensions: { maxHeight: 760 } } });
  bridge.oninitialized = () => { rec.initialized = true; };
  bridge.onmessage = async (p) => { rec.messages.push(p); return {}; };
  bridge.onupdatemodelcontext = async (p) => { rec.contexts.push(p); return {}; };
  bridge.onopenlink = async (p) => { rec.links.push(p); return {}; };
  bridge.ondownloadfile = async (p) => { rec.downloads.push(p); return {}; };
  bridge.onrequestdisplaymode = async (p) => {
    rec.displayModes.push(p.mode);
    await bridge.sendHostContextChange({ displayMode: p.mode });
    return { mode: p.mode };
  };
  const forward = bridge.oncalltool; // keep the SDK's default proxy to the MCP server, but record what the app calls
  void forward;
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = html;

  rec.setTheme = async (t) => { await bridge.sendHostContextChange({ theme: t }); };
  rec.run = async (name, args, partials = []) => {
    for (let i = 0; i < 200 && !rec.initialized; i++) await sleep(50);
    for (const partial of partials) { await bridge.sendToolInputPartial({ arguments: partial }); await sleep(120); }
    if (partials.length) await sleep(1800); // a real model keeps generating for a while after the first chunks
    await bridge.sendToolInput({ arguments: args });
    const result = await client.callTool({ name, arguments: args });
    await bridge.sendToolResult(result as never);
    return result;
  };
  rec.ready = true;
}
main().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<pre id="err">${String(e?.stack ?? e)}</pre>`); (window as unknown as { __err: string }).__err = String(e?.stack ?? e); });

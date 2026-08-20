import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js"
import { z } from "zod/v3"
import { pageSchema } from "../core/pageDocument"
import type { Page, PageContent } from "../core/types"
import { getCurrentUser } from "./luvabase"

const JSON_HEADERS = {
  "content-type": "application/json",
}

const PROSEMIRROR_INSTRUCTION =
  'Skrivla content uses ProseMirror JSON and sequential transaction positions. Read a document before editing it. The first operation uses positions from that read_document snapshot; each later operation uses positions in the document produced by all preceding operations in the same list. Block insertions use top-level boundaries, and inline operations use text positions. An empty paragraph is {"type":"paragraph"}.'

const prosemirrorMarkSchema = z.object({
  type: z.string().min(1),
  attrs: z.record(z.unknown()).optional(),
})
const prosemirrorNodeSchema = z
  .object({
    type: z.string().min(1),
    attrs: z.record(z.unknown()).optional(),
    content: z.array(z.unknown()).optional(),
    marks: z.array(prosemirrorMarkSchema).optional(),
    text: z.string().optional(),
  })
  .passthrough()
const editOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("insert"),
    position: z.number().int().nonnegative(),
    content: z
      .array(prosemirrorNodeSchema)
      .min(1)
      .describe("ProseMirror node JSON to insert at the position"),
  }),
  z.object({
    type: z.literal("replace"),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    content: z.array(prosemirrorNodeSchema).describe("Replacement ProseMirror node JSON"),
  }),
  z.object({
    type: z.literal("delete"),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("add_mark"),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    mark: prosemirrorMarkSchema,
  }),
  z.object({
    type: z.literal("remove_mark"),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    mark: prosemirrorMarkSchema,
  }),
  z.object({
    type: z.literal("set_node_markup"),
    position: z.number().int().nonnegative().describe("Position immediately before the node"),
    node_type: z.string().min(1).optional(),
    attrs: z.record(z.unknown()).optional(),
    marks: z.array(prosemirrorMarkSchema).optional(),
  }),
])

const pageMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  creatorId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})
const documentSnapshotSchema = z.object({
  documentId: z.string(),
  snapshotId: z.string(),
  revision: z.string(),
  updatedAt: z.string().nullable(),
  markdown: z.string(),
  text: z.string(),
  tiptapJson: z.record(z.unknown()),
  prosemirrorSize: z.number().int().nonnegative(),
  blocks: z.array(
    z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      type: z.string(),
      text: z.string(),
      empty: z.boolean(),
    }),
  ),
  segments: z.array(
    z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      text: z.string(),
      marks: z.array(z.string()),
    }),
  ),
})

type JsonToolResult = {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

type McpToolConfig<
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  title: string
  description: string
  inputSchema: InputSchema
  outputSchema: OutputSchema
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint?: boolean
    openWorldHint: boolean
  }
}

type McpToolDefinition = {
  name: string
  config: McpToolConfig<z.ZodTypeAny>
}

const mcpSchemaToJson = toJsonSchemaCompat as unknown as (
  schema: unknown,
  options: { strictUnions: boolean; pipeStrategy: "input" | "output" },
) => Record<string, unknown>

export async function handleMcpRequest(request: Request, env: Cloudflare.Env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: mcpCorsHeaders(),
    })
  }

  if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) {
    return mcpDiscoveryPage(request, env)
  }

  const server = createMcpServer(request, env)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await server.connect(transport)
  const response = await transport.handleRequest(request)
  const headers = new Headers(response.headers)

  for (const [name, value] of Object.entries(mcpCorsHeaders())) {
    headers.set(name, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function createMcpServer(
  request: Request,
  env: Cloudflare.Env,
  onTool?: (tool: McpToolDefinition) => void,
) {
  const server = new McpServer(
    {
      name: "skrivla",
      version: "0.1.0",
    },
    {
      instructions: PROSEMIRROR_INSTRUCTION,
    },
  )

  function registerTool<InputSchema extends z.ZodTypeAny>(
    name: string,
    config: McpToolConfig<InputSchema>,
    handler: (input: z.infer<InputSchema>) => Promise<JsonToolResult>,
  ) {
    registerMcpTool(server, name, config, handler)
    onTool?.({ name, config })
  }

  registerTool(
    "list_documents",
    {
      title: "List Skrivla documents",
      description:
        "List available Skrivla documents. Use this first when the user asks to work with a Skrivla document but has not supplied its document ID. Results include a short content preview.",
      inputSchema: z.object({
        query: z.string().optional().describe("Optional case-insensitive title or preview search"),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      outputSchema: z.object({
        documents: z.array(pageMetadataSchema.extend({ preview: z.string() })),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      try {
        const pages = await listPages(env)
        const documents = await Promise.all(
          pages.map(async (page) => ({
            ...page,
            preview: await getPagePreview(env, page.id),
          })),
        )
        const normalizedQuery = query?.trim().toLocaleLowerCase()
        const matches = normalizedQuery
          ? documents.filter((document) =>
              `${document.name}\n${document.preview}`.toLocaleLowerCase().includes(normalizedQuery),
            )
          : documents

        return jsonResult({ documents: matches.slice(0, limit) })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  registerTool(
    "read_document",
    {
      title: "Read a Skrivla document",
      description:
        "Read a Skrivla document and create a revision-safe editing snapshot. tiptapJson is the current ProseMirror document JSON. Blocks and segments provide positions for the first edit_document operation; later operations use the document produced by preceding operations.",
      inputSchema: z.object({
        document_id: z.string().min(1),
      }),
      outputSchema: documentSnapshotSchema.extend({
        title: z.string(),
        createdAt: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ document_id }) => {
      try {
        const page = await getPage(env, document_id)
        const document = await pageRequest(env, document_id, "mcp/read", {
          method: "POST",
        })

        return jsonResult({
          ...document,
          title: page.name,
          createdAt: page.createdAt,
        })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  registerTool(
    "create_document",
    {
      title: "Create a Skrivla document",
      description: `Create a new Skrivla document with optional initial ProseMirror nodes. ${PROSEMIRROR_INSTRUCTION}`,
      inputSchema: z.object({
        title: z.string().default(""),
        content: z
          .array(prosemirrorNodeSchema)
          .default([])
          .describe("Initial top-level ProseMirror node JSON; omit for an empty paragraph"),
      }),
      outputSchema: z.object({
        document: pageMetadataSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, content }) => {
      try {
        const tiptapJson = createProseMirrorDocument(content).toJSON()
        const page = await createPage(env, title, getCurrentUser(request)?.id ?? "public-mcp")

        await pageRequest(env, page.id, "content", {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tiptapJson: JSON.stringify(tiptapJson) }),
        })

        return jsonResult({ document: page })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  registerTool(
    "edit_document",
    {
      title: "Edit a Skrivla document",
      description: `Apply a sequential ProseMirror-style transaction containing insert, replace, delete, mark, and node-markup operations, then merge its Yjs delta. The first operation addresses the read_document snapshot; every later operation addresses the document resulting from preceding operations. To make several independent edits using unchanged snapshot positions, order them from the end of the document toward the beginning. Supported nodes include paragraph, heading (attrs.level 1-6), text, bulletList, orderedList, listItem, blockquote, codeBlock, horizontalRule, and hardBreak. Supported marks include bold, italic, strike, code, underline, and link. ${PROSEMIRROR_INSTRUCTION}`,
      inputSchema: z.object({
        document_id: z.string().min(1),
        snapshot_id: z.string().min(1),
        title: z.string().optional().describe("Optional new document title"),
        operations: z.array(editOperationSchema).max(100).default([]),
      }),
      outputSchema: z.object({
        document: pageMetadataSchema,
        appliedOperations: z.number().int().nonnegative(),
        editingSnapshot: documentSnapshotSchema.nullable(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ document_id, snapshot_id, title, operations }) => {
      try {
        if (title === undefined && operations.length === 0) {
          throw new Error("Supply a title or at least one edit operation")
        }

        const editedDocument =
          operations.length > 0
            ? await pageRequest(env, document_id, "mcp/edit", {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({ snapshotId: snapshot_id, operations }),
              })
            : null

        if (!editedDocument) await getPage(env, document_id)

        const page =
          title === undefined
            ? await getPage(env, document_id)
            : await renamePage(env, document_id, title)

        return jsonResult({
          document: page,
          appliedOperations: operations.length,
          editingSnapshot: editedDocument,
        })
      } catch (error) {
        return toolError(error)
      }
    },
  )

  return server
}

function mcpDiscoveryPage(request: Request, env: Cloudflare.Env) {
  const tools: McpToolDefinition[] = []
  createMcpServer(request, env, (tool) => tools.push(tool))

  const endpoint = new URL(request.url)
  endpoint.search = ""
  endpoint.hash = ""

  const toolCards = tools
    .map(({ name, config }) => {
      const inputSchema = mcpSchemaToJson(config.inputSchema, {
        strictUnions: true,
        pipeStrategy: "input",
      })
      const outputSchema = mcpSchemaToJson(config.outputSchema, {
        strictUnions: true,
        pipeStrategy: "output",
      })
      const badges = [
        config.annotations.readOnlyHint ? "Read only" : "Writes data",
        config.annotations.destructiveHint ? "Destructive" : null,
        config.annotations.idempotentHint ? "Idempotent" : null,
      ].filter(Boolean)

      return `<article class="tool">
        <div class="tool-heading">
          <div>
            <code class="tool-name">${escapeHtml(name)}</code>
            <h2>${escapeHtml(config.title)}</h2>
          </div>
          <div class="badges">${badges.map((badge) => `<span>${escapeHtml(badge!)}</span>`).join("")}</div>
        </div>
        <p>${escapeHtml(config.description)}</p>
        <details>
          <summary>Input schema</summary>
          <pre><code>${escapeHtml(JSON.stringify(inputSchema, null, 2))}</code></pre>
        </details>
        <details>
          <summary>Output schema</summary>
          <pre><code>${escapeHtml(JSON.stringify(outputSchema, null, 2))}</code></pre>
        </details>
      </article>`
    })
    .join("")

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Skrivla MCP server</title>
    <meta name="description" content="Connect to Skrivla's MCP server and discover its tools.">
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #25231f; background: #f4f1ea; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { width: min(880px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0 96px; }
      .eyebrow { color: #6f6a5f; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { max-width: 680px; margin: 14px 0 18px; font-family: Georgia, "Times New Roman", serif; font-size: clamp(42px, 8vw, 72px); font-weight: 500; letter-spacing: -.04em; line-height: .98; }
      .intro { max-width: 670px; margin: 0; color: #5e594f; font-size: 19px; line-height: 1.65; }
      .endpoint { display: flex; align-items: center; gap: 12px; margin: 36px 0 64px; padding: 18px 20px; border: 1px solid #d7d1c5; border-radius: 12px; background: #fffdf8; box-shadow: 0 8px 30px rgb(72 62 43 / 6%); }
      .endpoint span { flex: 0 0 auto; color: #777064; font-size: 13px; font-weight: 700; text-transform: uppercase; }
      .endpoint code { min-width: 0; overflow-wrap: anywhere; color: #2e5e49; font-size: 15px; }
      .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
      .section-heading h2 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: 32px; font-weight: 500; }
      .section-heading p { margin: 0; color: #777064; }
      .tools { display: grid; gap: 16px; }
      .tool { padding: 26px; border: 1px solid #d7d1c5; border-radius: 14px; background: #fffdf8; }
      .tool-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
      .tool-name { color: #2e5e49; font-size: 13px; font-weight: 700; }
      .tool h2 { margin: 6px 0 0; font-family: Georgia, "Times New Roman", serif; font-size: 24px; font-weight: 500; }
      .tool > p { margin: 16px 0 20px; color: #5e594f; line-height: 1.65; }
      .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
      .badges span { padding: 5px 9px; border-radius: 999px; background: #ebe7dd; color: #655f54; font-size: 11px; font-weight: 700; white-space: nowrap; }
      details { border-top: 1px solid #e3ded4; padding-top: 16px; }
      summary { color: #3f6f59; cursor: pointer; font-size: 14px; font-weight: 700; }
      pre { max-height: 420px; overflow: auto; margin: 14px 0 0; padding: 18px; border-radius: 10px; background: #262a27; color: #edf0eb; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
      footer { margin-top: 40px; color: #777064; font-size: 13px; line-height: 1.6; }
      @media (max-width: 620px) { main { padding-top: 44px; } .endpoint, .tool-heading { align-items: flex-start; flex-direction: column; } .badges { justify-content: flex-start; } .section-heading { align-items: flex-start; flex-direction: column; gap: 6px; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="eyebrow">Model Context Protocol</div>
        <h1>Write with Skrivla from your AI tools.</h1>
        <p class="intro">This is Skrivla's MCP endpoint. Connect an MCP-compatible client to discover, read, create, and edit collaborative documents. MCP clients communicate with this URL using Streamable HTTP.</p>
        <div class="endpoint"><span>Endpoint</span><code>${escapeHtml(endpoint.toString())}</code></div>
      </header>
      <section aria-labelledby="tools-heading">
        <div class="section-heading">
          <h2 id="tools-heading">Available tools</h2>
          <p>${tools.length} tools, generated from the live server registry</p>
        </div>
        <div class="tools">${toolCards}</div>
      </section>
      <footer>This page is shown for browser requests. MCP protocol requests to the same URL continue to receive machine-readable responses.</footer>
    </main>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  )
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!,
  )
}

function registerMcpTool<InputSchema extends z.ZodTypeAny>(
  server: McpServer,
  name: string,
  config: McpToolConfig<InputSchema>,
  handler: (input: z.infer<InputSchema>) => Promise<JsonToolResult>,
) {
  const register = server.registerTool as unknown as (
    toolName: string,
    toolConfig: McpToolConfig<InputSchema>,
    toolHandler: (input: z.infer<InputSchema>) => Promise<JsonToolResult>,
  ) => unknown

  register.call(server, name, config, handler)
}

function createProseMirrorDocument(content: unknown[]) {
  if (content.length === 0) {
    const document = pageSchema.topNodeType.createAndFill()
    if (!document) {
      throw new Error("Could not create an empty Skrivla document")
    }
    return document
  }

  const nodes = content.map((value) => {
    const node = pageSchema.nodeFromJSON(value)
    node.check()
    return node
  })
  const document = pageSchema.topNodeType.createChecked(null, nodes)
  document.check()
  return document
}

async function workspaceRequest(env: Cloudflare.Env, path: string, init: RequestInit = {}) {
  const stub = env.WORKSPACE_DO.getByName("workspace")
  const response = await stub.fetch(new Request(`https://workspace-do/${path}`, init))

  if (!response.ok) {
    throw new Error(
      `Skrivla workspace request failed (${response.status}): ${await response.text()}`,
    )
  }

  return response
}

async function pageRequest(
  env: Cloudflare.Env,
  pageId: string,
  action: string,
  init: RequestInit = {},
) {
  const stub = env.PAGE_DO.getByName(pageId)
  const pathname =
    action === "content"
      ? `/api/pages/${encodeURIComponent(pageId)}/content`
      : `/internal/pages/${encodeURIComponent(pageId)}/${action}`
  const response = await stub.fetch(new Request(`https://page-do${pathname}`, init))

  if (!response.ok) {
    throw new Error(
      `Skrivla document request failed (${response.status}): ${await response.text()}`,
    )
  }

  if (response.status === 204) {
    return null
  }

  return response.json() as Promise<Record<string, unknown>>
}

async function listPages(env: Cloudflare.Env) {
  const response = await workspaceRequest(env, "internal/mcp/pages")
  return response.json() as Promise<Page[]>
}

async function getPage(env: Cloudflare.Env, pageId: string) {
  const response = await workspaceRequest(env, `internal/pages/${encodeURIComponent(pageId)}`)
  return response.json() as Promise<Page>
}

async function createPage(env: Cloudflare.Env, title: string, creatorId: string) {
  const response = await workspaceRequest(env, "internal/mcp/pages", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title, creatorId }),
  })
  return response.json() as Promise<Page>
}

async function renamePage(env: Cloudflare.Env, pageId: string, title: string) {
  const response = await workspaceRequest(env, `internal/mcp/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  })
  return response.json() as Promise<Page>
}

async function getPagePreview(env: Cloudflare.Env, pageId: string) {
  try {
    const stub = env.PAGE_DO.getByName(pageId)
    const response = await stub.fetch(
      new Request(`https://page-do/api/pages/${encodeURIComponent(pageId)}/content`),
    )
    if (!response.ok) {
      return ""
    }

    const content = (await response.json()) as PageContent | null
    const text = content?.text?.replace(/\s+/g, " ").trim() ?? ""
    return text.length > 240 ? `${text.slice(0, 237)}...` : text
  } catch {
    return ""
  }
}

function jsonResult(value: Record<string, unknown>): JsonToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function toolError(error: unknown): JsonToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : "Unknown Skrivla error",
      },
    ],
    isError: true,
  }
}

function mcpCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    "access-control-expose-headers": "Mcp-Session-Id, Mcp-Protocol-Version",
  }
}

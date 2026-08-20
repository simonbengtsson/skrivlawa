import { DurableObject } from "cloudflare:workers"
import { Fragment, type Mark as ProseMirrorMark } from "@tiptap/pm/model"
import { Transform } from "@tiptap/pm/transform"
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite/driver"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import {
  initProseMirrorDoc,
  prosemirrorJSONToYDoc,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import { PAGE_DOC_FIELD, pageSchema, serializePageBodyMarkdown } from "../core/pageDocument"
import { pages } from "../core/schema"
import type { PageContent } from "../core/types"
import { generateShortId } from "../core/utils"
import { getCurrentUser, getDevMembers, getEnvironment, isAuthenticated } from "./luvabase"
import { handleMcpRequest } from "./mcp"
import { migrations } from "./migrations"

const WORKSPACE_DO_NAME = "workspace"
const PAGE_CONTENT_KEY = "content"
const PAGE_DOCUMENT_KEY = "document"
const MCP_SNAPSHOT_PREFIX = "mcp-snapshot:"
const MCP_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3

type PageSocketAttachment = {
  awarenessClientIds: number[]
}

type McpSnapshot = {
  createdAt: string
  document: string
}

type ProseMirrorJson = Record<string, unknown>
type ProseMirrorMarkJson = {
  type: string
  attrs?: Record<string, unknown>
}

type McpEditOperation =
  | { type: "insert"; position: number; content: ProseMirrorJson[] }
  | { type: "replace"; from: number; to: number; content: ProseMirrorJson[] }
  | { type: "delete"; from: number; to: number }
  | {
      type: "add_mark" | "remove_mark"
      from: number
      to: number
      mark: ProseMirrorMarkJson
    }
  | {
      type: "set_node_markup"
      position: number
      node_type?: string
      attrs?: Record<string, unknown>
      marks?: ProseMirrorMarkJson[]
    }

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url)

    if (url.pathname === "/api/dev-members") {
      const members = await getDevMembers()
      return Response.json(members)
    }

    if (url.pathname === "/api/session") {
      const currentUser = getCurrentUser(request)
      return Response.json({
        user: currentUser,
        environment: getEnvironment(),
      })
    }

    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, env)
    }

    const collaborationMatch = matchPageCollaborationPath(url.pathname)
    if (collaborationMatch) {
      const stub = env.PAGE_DO.getByName(collaborationMatch.pageId)
      return stub.fetch(request)
    }

    const pageContentMatch = matchPageContentPath(url.pathname)
    if (pageContentMatch) {
      const stub = env.PAGE_DO.getByName(pageContentMatch.pageId)
      return stub.fetch(request)
    }

    if (url.pathname.startsWith("/api/pages")) {
      const stub = env.WORKSPACE_DO.getByName(WORKSPACE_DO_NAME)
      return stub.fetch(request)
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  },
}

export class WorkspaceDO extends DurableObject {
  private db: ReturnType<typeof drizzle>

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env)

    this.db = drizzle(state.storage, {
      schema: {
        pages,
      },
    })

    state.blockConcurrencyWhile(async () => {
      await migrate(this.db, { migrations })
    })
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (pathname === "/internal/mcp/pages") {
      if (request.method === "GET") {
        const currentPages = await this.db
          .select()
          .from(pages)
          .where(isNull(pages.deletedAt))
          .orderBy(desc(pages.updatedAt))

        return Response.json(currentPages)
      }

      if (request.method === "POST") {
        const body = await readJsonBody<{ title?: string; creatorId?: string }>(request)
        const now = new Date().toISOString()
        const page = {
          id: generateShortId(),
          name: body.title ?? "",
          creatorId: body.creatorId ?? "public-mcp",
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }

        await this.db.insert(pages).values(page)
        return Response.json(page, { status: 201 })
      }
    }

    const internalMcpPageMatch = pathname.match(/^\/internal\/mcp\/pages\/([^/]+)$/)
    if (internalMcpPageMatch && request.method === "PATCH") {
      const pageId = decodeURIComponent(internalMcpPageMatch[1]!)
      const page = await this.getPageById(pageId)
      if (!page) {
        return new Response("Not found", { status: 404 })
      }

      const body = await readJsonBody<{ title?: string }>(request)
      const now = new Date().toISOString()
      await this.db
        .update(pages)
        .set({ name: body.title ?? page.name, updatedAt: now })
        .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))

      return Response.json(await this.getPageById(pageId))
    }

    const internalPageMatch = matchInternalPagePath(pathname)
    if (internalPageMatch) {
      const page = await this.getPageById(internalPageMatch.pageId)

      if (!page) {
        return new Response("Not found", { status: 404 })
      }

      if (internalPageMatch.action === undefined && request.method === "GET") {
        return Response.json(page)
      }

      if (internalPageMatch.action === "touch" && request.method === "POST") {
        const body = await readJsonBody<{ updatedAt?: string }>(request)
        const updatedPage = await this.touchPage(
          internalPageMatch.pageId,
          body.updatedAt ?? new Date().toISOString(),
        )
        return Response.json(updatedPage)
      }
    }

    if (pathname === "/api/pages" && request.method === "GET") {
      const user = await getCurrentUser(request)
      if (!user) {
        return new Response("Unauthorized", { status: 401 })
      }

      const currentPages = await this.db
        .select()
        .from(pages)
        .where(and(eq(pages.creatorId, user.id), isNull(pages.deletedAt)))
        .orderBy(desc(pages.createdAt))

      return Response.json(currentPages)
    }

    if (pathname === "/api/pages/trash" && request.method === "GET") {
      if (!isAuthenticated(request)) {
        return new Response("Unauthorized", { status: 401 })
      }

      const deletedPages = await this.db
        .select()
        .from(pages)
        .where(isNotNull(pages.deletedAt))
        .orderBy(desc(pages.deletedAt), desc(pages.createdAt))

      return Response.json(deletedPages)
    }

    if (pathname === "/api/pages" && request.method === "POST") {
      const user = getCurrentUser(request)
      if (!user) {
        return new Response("Unauthorized", { status: 401 })
      }

      const body = await readJsonBody<{ name?: string }>(request)
      const now = new Date().toISOString()

      const page = {
        id: generateShortId(),
        name: body.name ?? "",
        creatorId: user.id,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }

      await this.db.insert(pages).values(page)
      return Response.json(page, { status: 201 })
    }

    const restoreMatch = pathname.match(/^\/api\/pages\/([^/]+)\/restore$/)
    if (restoreMatch && request.method === "POST") {
      if (!isAuthenticated(request)) {
        return new Response("Unauthorized", { status: 401 })
      }

      const pageId = decodeURIComponent(restoreMatch[1]!)
      const deletedPage = await this.getPageById(pageId, {
        includeDeleted: true,
      })

      if (!deletedPage || deletedPage.deletedAt === null) {
        return new Response("Not found", { status: 404 })
      }

      const restoredAt = new Date().toISOString()

      await this.db
        .update(pages)
        .set({
          updatedAt: restoredAt,
          deletedAt: null,
        })
        .where(and(eq(pages.id, pageId), isNotNull(pages.deletedAt)))

      const restoredPage = await this.getPageById(pageId)
      return Response.json(restoredPage)
    }

    const pageMatch = pathname.match(/^\/api\/pages\/([^/]+)$/)
    if (pageMatch) {
      const pageId = decodeURIComponent(pageMatch[1]!)
      const page = await this.getPageById(pageId)

      if (request.method === "GET") {
        if (!page) {
          return new Response("Not found", { status: 404 })
        }

        return Response.json(page)
      }

      if (!page) {
        return new Response("Not found", { status: 404 })
      }

      if (request.method === "PATCH") {
        const body = await readJsonBody<{ name?: string }>(request)
        const now = new Date().toISOString()

        await this.db
          .update(pages)
          .set({
            name: body.name ?? page.name,
            updatedAt: now,
          })
          .where(eq(pages.id, pageId))

        const updatedPage = await this.getPageById(pageId)
        return Response.json(updatedPage)
      }

      if (request.method === "DELETE") {
        if (!isAuthenticated(request)) {
          return new Response("Unauthorized", { status: 401 })
        }

        const deletedAt = new Date().toISOString()

        await this.deletePageContent(pageId)
        await this.db
          .update(pages)
          .set({
            updatedAt: deletedAt,
            deletedAt,
          })
          .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))

        const deletedPage = await this.getPageById(pageId, {
          includeDeleted: true,
        })

        return Response.json(deletedPage)
      }
    }

    return new Response("Not found", { status: 404 })
  }

  private async touchPage(pageId: string, updatedAt: string) {
    await this.db
      .update(pages)
      .set({ updatedAt })
      .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))

    return this.getPageById(pageId)
  }

  private async getPageById(pageId: string, options: { includeDeleted?: boolean } = {}) {
    const filters = [eq(pages.id, pageId)]

    if (!options.includeDeleted) {
      filters.push(isNull(pages.deletedAt))
    }

    const [page] = await this.db
      .select()
      .from(pages)
      .where(and(...filters))
      .limit(1)

    return page ?? null
  }

  private async deletePageContent(pageId: string) {
    const stub = this.env.PAGE_DO.getByName(pageId)
    const response = await stub.fetch(
      new Request(`https://page-do/internal/pages/${encodeURIComponent(pageId)}/purge`, {
        method: "POST",
      }),
    )

    if (!response.ok) {
      throw new Error(`Failed to purge page content for ${pageId}: ${response.status}`)
    }
  }
}

export class PageDO extends DurableObject {
  private readonly pageId: string
  private readonly doc: Y.Doc
  private readonly awareness: awarenessProtocol.Awareness

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env)

    this.pageId = state.id.name ?? ""
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)

    this.restoreDocument()

    this.doc.on("update", (update, origin) => {
      const updatedAt = new Date().toISOString()
      this.persistDocument(updatedAt)
      this.ctx.waitUntil(this.touchPage(this.pageId, updatedAt))
      this.broadcastSyncUpdate(update, origin instanceof WebSocket ? origin : null)
    })

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changedClients = [...added, ...updated, ...removed]
        if (changedClients.length === 0) {
          return
        }

        this.broadcast(encodeAwarenessMessage(this.awareness, changedClients), null)
      },
    )
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    const pathname = url.pathname

    const internalMcpMatch = matchInternalPageMcpPath(pathname)
    if (internalMcpMatch) {
      const pageExists = await this.pageExists(internalMcpMatch.pageId)
      if (!pageExists) {
        return new Response("Not found", { status: 404 })
      }

      this.ensureDocumentLoaded()

      if (internalMcpMatch.action === "read" && request.method === "POST") {
        return Response.json(this.createMcpSnapshot())
      }

      if (internalMcpMatch.action === "edit" && request.method === "POST") {
        try {
          const body = await readJsonBody<{
            snapshotId?: string
            operations?: McpEditOperation[]
          }>(request)
          this.applyMcpEdits(body.snapshotId ?? "", body.operations ?? [])
          return Response.json(this.createMcpSnapshot())
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Invalid edit" },
            { status: 400 },
          )
        }
      }

      return new Response("Method not allowed", { status: 405 })
    }

    const internalPurgeMatch = matchInternalPagePurgePath(pathname)
    if (internalPurgeMatch && request.method === "POST") {
      for (const socket of this.ctx.getWebSockets()) {
        socket.close(1001, "Page deleted")
      }

      this.ctx.storage.kv.delete(PAGE_CONTENT_KEY)
      this.ctx.storage.kv.delete(PAGE_DOCUMENT_KEY)
      return new Response(null, { status: 204 })
    }

    const collaborationMatch = matchPageCollaborationPath(pathname)
    if (collaborationMatch) {
      const pageExists = await this.pageExists(collaborationMatch.pageId)
      if (!pageExists) {
        return new Response("Not found", { status: 404 })
      }

      this.ensureDocumentLoaded()

      if (request.method === "GET" && pathname.endsWith("/debug")) {
        return Response.json({
          ok: true,
          pageId: this.pageId,
          sockets: this.ctx.getWebSockets().length,
          textLength: this.doc.getXmlFragment(PAGE_DOC_FIELD).toString().length,
        })
      }

      return this.handleCollaborationRequest(request)
    }

    const contentMatch = matchPageContentPath(pathname)
    if (!contentMatch) {
      return new Response("Not found", { status: 404 })
    }

    const pageExists = await this.pageExists(contentMatch.pageId)
    if (!pageExists) {
      return new Response("Not found", { status: 404 })
    }

    if (request.method === "GET") {
      const existingContent = this.ctx.storage.kv.get<PageContent>(PAGE_CONTENT_KEY)
      return Response.json(existingContent ?? null)
    }

    if (request.method === "PUT") {
      const body = await readJsonBody<{
        tiptapJson?: string | null
        text?: string | null
      }>(request)
      const updatedAt = new Date().toISOString()

      const content: PageContent = {
        id: this.pageId,
        updatedAt,
        tiptapJson: body.tiptapJson ?? null,
        text: body.text ?? null,
      }

      this.ctx.storage.kv.put(PAGE_CONTENT_KEY, content)

      if (body.tiptapJson) {
        try {
          const persistedDoc = prosemirrorJSONToYDoc(
            pageSchema,
            JSON.parse(body.tiptapJson),
            PAGE_DOC_FIELD,
          )
          const persistedUpdate = Y.encodeStateAsUpdate(persistedDoc)
          this.ctx.storage.kv.put(PAGE_DOCUMENT_KEY, encodeStoredDocument(persistedUpdate))

          if (this.doc.getXmlFragment(PAGE_DOC_FIELD).toString().length === 0) {
            Y.applyUpdate(this.doc, persistedUpdate, "content-put")
          }
        } catch {}
      }

      await this.touchPage(this.pageId, updatedAt)

      return Response.json(content)
    }

    return new Response("Method not allowed", { status: 405 })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      return
    }

    const decoder = decoding.createDecoder(new Uint8Array(message))
    const messageType = decoding.readVarUint(decoder)

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws)

      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder))
      }

      if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
        const syncStep1Encoder = encoding.createEncoder()
        encoding.writeVarUint(syncStep1Encoder, MESSAGE_SYNC)
        syncProtocol.writeSyncStep1(syncStep1Encoder, this.doc)

        const syncStep1Message = encoding.toUint8Array(syncStep1Encoder)
        ws.send(syncStep1Message)
      }

      return
    }

    if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder)
      this.trackSocketAwarenessClients(ws, getAwarenessClientIds(update))
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws)
      return
    }

    if (messageType === MESSAGE_QUERY_AWARENESS) {
      const clientIds = Array.from(this.awareness.getStates().keys())
      if (clientIds.length > 0) {
        ws.send(encodeAwarenessMessage(this.awareness, clientIds))
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    this.removeSocketAwareness(ws)
  }

  webSocketError(ws: WebSocket) {
    this.removeSocketAwareness(ws)
  }

  private restoreDocument() {
    const storedDocument = this.ctx.storage.kv.get<string | Uint8Array | number[]>(
      PAGE_DOCUMENT_KEY,
    )
    const decodedDocument = decodeStoredDocument(storedDocument)
    if (decodedDocument) {
      Y.applyUpdate(this.doc, decodedDocument, "storage")
      return
    }
  }

  private handleCollaborationRequest(request: Request) {
    if (request.method !== "GET" || !isWebSocketRequest(request)) {
      return new Response("Expected Upgrade: websocket", { status: 426 })
    }

    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)

    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      awarenessClientIds: [],
    } satisfies PageSocketAttachment)

    const activeClientIds = Array.from(this.awareness.getStates().keys())
    if (activeClientIds.length > 0) {
      server.send(encodeAwarenessMessage(this.awareness, activeClientIds))
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  private ensureDocumentLoaded() {
    if (this.doc.getXmlFragment(PAGE_DOC_FIELD).length > 0) {
      return
    }

    const storedDocument = this.ctx.storage.kv.get<string | Uint8Array | number[]>(
      PAGE_DOCUMENT_KEY,
    )
    const decodedDocument = decodeStoredDocument(storedDocument)

    if (!decodedDocument) {
      return
    }

    Y.applyUpdate(this.doc, decodedDocument, "storage-refresh")
  }

  private persistDocument(updatedAt: string) {
    const encodedState = Y.encodeStateAsUpdate(this.doc)
    const content = this.serializePageContent(updatedAt)

    this.ctx.storage.kv.put(PAGE_DOCUMENT_KEY, encodeStoredDocument(encodedState))
    this.ctx.storage.kv.put(PAGE_CONTENT_KEY, content)
  }

  private createMcpSnapshot() {
    const snapshotId = crypto.randomUUID()
    const now = new Date()
    const encodedDocument = Y.encodeStateAsUpdate(this.doc)
    const rootNode = yXmlFragmentToProseMirrorRootNode(
      this.doc.getXmlFragment(PAGE_DOC_FIELD),
      pageSchema,
    )
    const segments: Array<{
      from: number
      to: number
      text: string
      marks: string[]
    }> = []
    const blocks: Array<{
      from: number
      to: number
      type: string
      text: string
      empty: boolean
    }> = []

    rootNode.forEach((node, offset) => {
      blocks.push({
        from: offset,
        to: offset + node.nodeSize,
        type: node.type.name,
        text: node.textContent,
        empty: node.type.name === "paragraph" && node.content.size === 0,
      })
    })

    rootNode.descendants((node, position) => {
      if (node.isText && node.text) {
        segments.push({
          from: position,
          to: position + node.nodeSize,
          text: node.text,
          marks: node.marks.map((mark) => mark.type.name),
        })
      }
    })

    this.ctx.storage.kv.put(`${MCP_SNAPSHOT_PREFIX}${snapshotId}`, {
      createdAt: now.toISOString(),
      document: encodeStoredDocument(encodedDocument),
    } satisfies McpSnapshot)
    this.removeExpiredMcpSnapshots(now.getTime())

    const content = this.ctx.storage.kv.get<PageContent>(PAGE_CONTENT_KEY)

    return {
      documentId: this.pageId,
      snapshotId,
      revision: encodeStoredDocument(Y.encodeStateVector(this.doc)),
      updatedAt: content?.updatedAt ?? null,
      markdown: serializePageBodyMarkdown(this.doc),
      text: rootNode.textBetween(0, rootNode.content.size, "\n\n"),
      tiptapJson: rootNode.toJSON(),
      prosemirrorSize: rootNode.content.size,
      blocks,
      segments,
    }
  }

  private removeExpiredMcpSnapshots(now: number) {
    for (const [key, snapshot] of this.ctx.storage.kv.list<McpSnapshot>({
      prefix: MCP_SNAPSHOT_PREFIX,
    })) {
      if (now - Date.parse(snapshot.createdAt) > MCP_SNAPSHOT_MAX_AGE_MS) {
        this.ctx.storage.kv.delete(key)
      }
    }
  }

  private applyMcpEdits(snapshotId: string, operations: McpEditOperation[]) {
    const snapshotKey = `${MCP_SNAPSHOT_PREFIX}${snapshotId}`
    const snapshot = this.ctx.storage.kv.get<McpSnapshot>(snapshotKey)
    if (!snapshot) {
      throw new Error("Snapshot not found or expired; call read_document again")
    }

    if (Date.now() - Date.parse(snapshot.createdAt) > MCP_SNAPSHOT_MAX_AGE_MS) {
      this.ctx.storage.kv.delete(snapshotKey)
      throw new Error("Snapshot expired; call read_document again")
    }

    const snapshotUpdate = decodeStoredDocument(snapshot.document)
    if (!snapshotUpdate) {
      throw new Error("Snapshot is invalid; call read_document again")
    }

    const editingDoc = new Y.Doc()
    Y.applyUpdate(editingDoc, snapshotUpdate, "mcp-snapshot")
    const baseStateVector = Y.encodeStateVector(editingDoc)
    const fragment = editingDoc.getXmlFragment(PAGE_DOC_FIELD)
    const { doc: originalRoot, meta } = initProseMirrorDoc(fragment, pageSchema)
    const transform = new Transform(originalRoot)

    for (const operation of operations) {
      if (operation.type === "insert") {
        this.assertMcpPosition(operation.position, transform.doc.content.size)
        transform.insert(operation.position, this.parseProseMirrorContent(operation.content))
        continue
      }

      if (operation.type === "set_node_markup") {
        this.assertMcpPosition(operation.position, transform.doc.content.size)
        const nodeType = operation.node_type ? pageSchema.nodes[operation.node_type] : undefined
        if (operation.node_type && !nodeType) {
          throw new Error(`Unsupported node type: ${operation.node_type}`)
        }

        const marks = operation.marks?.map((mark) => this.parseProseMirrorMark(mark))
        transform.setNodeMarkup(operation.position, nodeType, operation.attrs, marks)
        continue
      }

      this.assertMcpRange(operation.from, operation.to, transform.doc.content.size)

      if (operation.type === "replace") {
        transform.replaceWith(
          operation.from,
          operation.to,
          this.parseProseMirrorContent(operation.content),
        )
        continue
      }

      if (operation.type === "delete") {
        transform.delete(operation.from, operation.to)
        continue
      }

      const mark = this.parseProseMirrorMark(operation.mark)

      if (operation.type === "add_mark") {
        transform.addMark(operation.from, operation.to, mark)
      } else {
        transform.removeMark(operation.from, operation.to, mark)
      }
    }

    transform.doc.check()
    updateYFragment(editingDoc, fragment, transform.doc, meta)
    const agentUpdate = Y.encodeStateAsUpdate(editingDoc, baseStateVector)
    Y.applyUpdate(this.doc, agentUpdate, "mcp")
    this.ctx.storage.kv.delete(snapshotKey)
  }

  private assertMcpPosition(position: number, documentSize: number) {
    if (!Number.isInteger(position) || position < 0 || position > documentSize) {
      throw new Error(`Position ${position} is outside the current transaction document`)
    }
  }

  private assertMcpRange(from: number, to: number, documentSize: number) {
    this.assertMcpPosition(from, documentSize)
    this.assertMcpPosition(to, documentSize)
    if (to < from) {
      throw new Error(`Range ${from}..${to} is invalid`)
    }
  }

  private parseProseMirrorContent(content: ProseMirrorJson[]) {
    const nodes = content.map((value) => {
      const node = pageSchema.nodeFromJSON(value)
      node.check()
      return node
    })
    return Fragment.fromArray(nodes)
  }

  private parseProseMirrorMark(mark: ProseMirrorMarkJson): ProseMirrorMark {
    const markType = pageSchema.marks[mark.type]
    if (!markType) {
      throw new Error(`Unsupported mark type: ${mark.type}`)
    }

    return markType.create(mark.attrs)
  }

  private serializePageContent(updatedAt: string): PageContent {
    const rootNode = yXmlFragmentToProseMirrorRootNode(
      this.doc.getXmlFragment(PAGE_DOC_FIELD),
      pageSchema,
    )
    const tiptapJson = rootNode.toJSON()

    return {
      id: this.pageId,
      updatedAt,
      tiptapJson: JSON.stringify(tiptapJson),
      text: rootNode.textBetween(0, rootNode.content.size, "\n\n"),
    }
  }

  private broadcastSyncUpdate(update: Uint8Array, skipSocket: WebSocket | null) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this.broadcast(encoding.toUint8Array(encoder), skipSocket)
  }

  private broadcast(message: Uint8Array, skipSocket: WebSocket | null) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === skipSocket) {
        continue
      }

      socket.send(message)
    }
  }

  private getSocketAttachment(ws: WebSocket): PageSocketAttachment {
    const attachment = ws.deserializeAttachment() as PageSocketAttachment | null

    return {
      awarenessClientIds: attachment?.awarenessClientIds ?? [],
    }
  }

  private trackSocketAwarenessClients(ws: WebSocket, clientIds: number[]) {
    const attachment = this.getSocketAttachment(ws)
    const awarenessClientIds = Array.from(new Set([...attachment.awarenessClientIds, ...clientIds]))

    ws.serializeAttachment({
      awarenessClientIds,
    } satisfies PageSocketAttachment)
  }

  private removeSocketAwareness(ws: WebSocket) {
    const attachment = this.getSocketAttachment(ws)
    if (attachment.awarenessClientIds.length === 0) {
      return
    }

    awarenessProtocol.removeAwarenessStates(this.awareness, attachment.awarenessClientIds, ws)
  }

  private async pageExists(pageId: string) {
    const stub = this.env.WORKSPACE_DO.getByName(WORKSPACE_DO_NAME)
    const response = await stub.fetch(
      new Request(`https://workspace-do/internal/pages/${encodeURIComponent(pageId)}`, {
        method: "GET",
      }),
    )

    if (response.status === 404) {
      return false
    }

    if (!response.ok) {
      throw new Error(`Failed to load page ${pageId}: ${response.status}`)
    }

    return true
  }

  private async touchPage(pageId: string, updatedAt: string) {
    const stub = this.env.WORKSPACE_DO.getByName(WORKSPACE_DO_NAME)
    const response = await stub.fetch(
      new Request(`https://workspace-do/internal/pages/${encodeURIComponent(pageId)}/touch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ updatedAt }),
      }),
    )

    if (!response.ok) {
      throw new Error(`Failed to touch page ${pageId}: ${response.status}`)
    }
  }
}

async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    return {} as T
  }
}

function encodeAwarenessMessage(awareness: awarenessProtocol.Awareness, clientIds: number[]) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds),
  )
  return encoding.toUint8Array(encoder)
}

function getAwarenessClientIds(update: Uint8Array) {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  const clientIds: number[] = []

  for (let index = 0; index < count; index += 1) {
    clientIds.push(decoding.readVarUint(decoder))
    decoding.readVarUint(decoder)
    decoding.readVarString(decoder)
  }

  return clientIds
}

function isWebSocketRequest(request: Request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket"
}

function encodeStoredDocument(update: Uint8Array) {
  let binary = ""

  for (const byte of update) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function decodeStoredDocument(value: string | Uint8Array | number[] | undefined) {
  if (!value) {
    return null
  }

  if (value instanceof Uint8Array) {
    return value
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value)
  }

  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return bytes
  } catch {
    return null
  }
}

function matchPageCollaborationPath(pathname: string) {
  const match = pathname.match(/^\/api\/collaboration\/([^/]+)(?:\/debug)?$/)
  if (!match) {
    return null
  }

  return {
    pageId: decodeURIComponent(match[1]!),
  }
}

function matchPageContentPath(pathname: string) {
  const match = pathname.match(/^\/api\/pages\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  return {
    pageId: decodeURIComponent(match[1]!),
  }
}

function matchInternalPagePath(pathname: string) {
  const match = pathname.match(/^\/internal\/pages\/([^/]+)(?:\/(touch))?$/)
  if (!match) {
    return null
  }

  return {
    pageId: decodeURIComponent(match[1]!),
    action: match[2],
  }
}

function matchInternalPagePurgePath(pathname: string) {
  const match = pathname.match(/^\/internal\/pages\/([^/]+)\/purge$/)
  if (!match) {
    return null
  }

  return {
    pageId: decodeURIComponent(match[1]!),
  }
}

function matchInternalPageMcpPath(pathname: string) {
  const match = pathname.match(/^\/internal\/pages\/([^/]+)\/mcp\/(read|edit)$/)
  if (!match) {
    return null
  }

  return {
    pageId: decodeURIComponent(match[1]!),
    action: match[2] as "read" | "edit",
  }
}

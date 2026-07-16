import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Store } from '../../persistence'
import { createDobiusToolHandlers, type DobiusToolContext } from './dobius-tool-handlers'

let knowledgeStore: Store | null = null

export type { DobiusToolContext }

export function setDobiusToolKnowledgeStore(store: Store): void {
  knowledgeStore = store
}

function asCallToolResult(
  result: Awaited<
    ReturnType<
      ReturnType<typeof createDobiusToolHandlers>[keyof ReturnType<typeof createDobiusToolHandlers>]
    >
  >
): CallToolResult {
  return result
}

export function buildDobiusToolServer(context: DobiusToolContext): McpSdkServerConfigWithInstance {
  const handlers = createDobiusToolHandlers(context, knowledgeStore)
  return createSdkMcpServer({
    name: 'dobius',
    version: '1.0.0',
    tools: [
      tool(
        'asana_draft_comment',
        'Queue a draft Asana comment for human approval. Never posts to Asana.',
        { gid: z.string(), body: z.string() },
        async (args) => asCallToolResult(await handlers.asanaDraftComment(args))
      ),
      tool(
        'dispatch_build',
        'Create a managed build worktree with a startup brief. Never pushes, merges, posts, or completes tasks.',
        { repo: z.string(), brief: z.string(), branchName: z.string().optional() },
        async (args) => asCallToolResult(await handlers.dispatchBuild(args))
      ),
      tool(
        'read_knowledge',
        'Read allowed Dobius knowledge by leaf id or title/summary query.',
        { query: z.string(), leafId: z.string().optional() },
        async (args) => asCallToolResult(await handlers.readKnowledge(args))
      ),
      tool(
        'list_crew',
        'List configured crew agents and compact capability metadata.',
        {},
        async () => asCallToolResult(await handlers.listCrew())
      ),
      tool(
        'crew_status',
        'Summarize the current and latest known run status for each crew agent.',
        {},
        async () => asCallToolResult(await handlers.crewStatus())
      ),
      tool(
        'file_briefing_item',
        'Surface a finding to the human briefing without posting externally.',
        { urgency: z.enum(['digest', 'now']), summary: z.string() },
        async (args) => asCallToolResult(await handlers.fileBriefingItem(args))
      )
    ]
  })
}

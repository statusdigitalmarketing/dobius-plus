import type { AgentDraftComment } from '../../shared/agents'
import { hasAsanaToken } from '../asana/asana-token-store'
import { postTaskComment } from '../asana/asana-client'
import { getDraft, setDraftStatus } from './agent-draft-store'

// Why: the pending→approved flip only happens after the network round-trip, so
// a second concurrent approve of the same id would pass the pending guard and
// double-post. Claim the id synchronously for the duration of the POST.
const postingDraftIds = new Set<string>()

export async function approveDraftAndPost(id: string): Promise<AgentDraftComment> {
  const draft = getDraft(id)
  if (!draft) {
    throw new Error('Draft not found')
  }
  if (draft.status !== 'pending') {
    throw new Error('Only pending drafts can be approved')
  }
  if (postingDraftIds.has(id)) {
    throw new Error('This draft is already being posted')
  }
  if (!hasAsanaToken()) {
    throw new Error('Asana not connected')
  }
  postingDraftIds.add(id)
  try {
    // Why: this function is reachable only from the human Approve & post IPC handler.
    await postTaskComment(draft.target.gid, draft.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not post draft to Asana: ${message}`)
  } finally {
    postingDraftIds.delete(id)
  }
  const approved = setDraftStatus(id, 'approved')
  if (!approved) {
    throw new Error('Draft not found after posting to Asana')
  }
  return approved
}

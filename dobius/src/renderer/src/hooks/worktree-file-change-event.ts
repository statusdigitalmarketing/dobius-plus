import type { FsChangedPayload } from '../../../shared/types'

export const DOBIUS_WORKTREE_FILE_CHANGE_EVENT = 'dobius:worktree-file-change'

export type WorktreeFileChangeEventDetail = {
  payload: FsChangedPayload
  runtimeEnvironmentId: string | null
}

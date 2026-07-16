export const DOBIUS_EDITOR_SAVE_DIRTY_FILES_EVENT = 'dobius:editor-save-dirty-files'
export const DOBIUS_EDITOR_PREPARE_HOT_EXIT_EVENT = 'dobius:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail

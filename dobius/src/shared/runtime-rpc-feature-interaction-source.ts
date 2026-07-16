export const DOBIUS_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY = '__dobiusFeatureInteractionSource'

export const DOBIUS_RUNTIME_RPC_BROWSER_UI_SOURCE = 'browser-pane-ui'

export function withBrowserPaneUiRuntimeRpcSource(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      [DOBIUS_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: DOBIUS_RUNTIME_RPC_BROWSER_UI_SOURCE
    }
  }
  return {
    ...value,
    [DOBIUS_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: DOBIUS_RUNTIME_RPC_BROWSER_UI_SOURCE
  }
}

export function isBrowserPaneUiRuntimeRpcParams(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[DOBIUS_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY] ===
      DOBIUS_RUNTIME_RPC_BROWSER_UI_SOURCE
  )
}

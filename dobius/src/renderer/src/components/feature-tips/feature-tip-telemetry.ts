import { track } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'

export type DobiusCliFeatureTipSource = EventProps<'dobius_cli_feature_tip_shown'>['source']
export type DobiusCliFeatureTipSetupResult = EventProps<'dobius_cli_feature_tip_setup_result'>['result']
export type CmdJPaletteFeatureTipSource = EventProps<'cmd_j_palette_feature_tip_shown'>['source']

export function getDobiusCliFeatureTipTelemetrySource(value: unknown): DobiusCliFeatureTipSource {
  return value === 'app_open' ? 'app_open' : 'manual'
}

export function trackDobiusCliFeatureTipShown(source: DobiusCliFeatureTipSource): void {
  track('dobius_cli_feature_tip_shown', { source })
}

export function trackDobiusCliFeatureTipSetupClicked(source: DobiusCliFeatureTipSource): void {
  track('dobius_cli_feature_tip_setup_clicked', { source })
}

export function trackDobiusCliFeatureTipSetupResult(
  source: DobiusCliFeatureTipSource,
  result: DobiusCliFeatureTipSetupResult
): void {
  track('dobius_cli_feature_tip_setup_result', { source, result })
}

export function trackCmdJPaletteFeatureTipShown(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_shown', { source })
}

export function trackCmdJPaletteFeatureTipAcknowledged(source: CmdJPaletteFeatureTipSource): void {
  track('cmd_j_palette_feature_tip_acknowledged', { source })
}

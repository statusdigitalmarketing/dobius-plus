import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { MobilePane } from './MobilePane'
import { ImessageBridgeSetting } from './ImessageBridgeSetting'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
  getMobileOverviewSearchEntry,
  getMobileSidebarShortcutSearchEntry,
  getMobileSettingsPaneSearchEntries
} from './mobile-settings-search'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
export { getMobileSettingsPaneSearchEntries }

// Placeholder until a Dobius+ mobile app is published — point at the project's
// own releases page instead of an external App Store listing / APK.
const DOBIUS_IOS_APP_STORE_URL = 'https://github.com/statusdigitalmarketing/dobius-plus/releases'
const DOBIUS_ANDROID_APK_URL = 'https://github.com/statusdigitalmarketing/dobius-plus/releases'

export function MobileSettingsPane(): React.JSX.Element {
  const showMobileButton = useAppStore((s) => s.settings?.showMobileButton !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="space-y-4">
      <SearchableSetting
        title={translate('auto.components.settings.MobileSettingsPane.e7a3ae8c4e', 'Mobile')}
        description={translate(
          'auto.components.settings.MobileSettingsPane.174f4a3c6d',
          'Control terminals and agents from your phone.'
        )}
        keywords={getMobileOverviewSearchEntry().keywords}
        className="space-y-3 py-2"
      >
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.MobileSettingsPane.c8491c17ef',
            'Control Dobius+ from your phone by scanning a QR code. Get the iOS app from the'
          )}{' '}
          <button
            type="button"
            onClick={() => void window.api.shell.openUrl(DOBIUS_IOS_APP_STORE_URL)}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            {translate('auto.components.settings.MobileSettingsPane.b5a2ed83ff', 'App Store')}
          </button>{' '}
          {translate(
            'auto.components.settings.MobileSettingsPane.b0088412a1',
            'or the Android APK from'
          )}{' '}
          <button
            type="button"
            // Why: Android is moving to Google Play soon, but until then
            // link directly to the pinned APK asset for the current mobile release.
            onClick={() => void window.api.shell.openUrl(DOBIUS_ANDROID_APK_URL)}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            {translate('auto.components.settings.MobileSettingsPane.9a3c280e49', 'GitHub Releases')}
          </button>
          .
        </p>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.MobileSettingsPane.1de96ec8a6',
          'Show Dobius+ Mobile Button'
        )}
        description={translate(
          'auto.components.settings.MobileSettingsPane.682293cadf',
          'Show the Dobius+ Mobile button at the top of the left sidebar.'
        )}
        keywords={getMobileSidebarShortcutSearchEntry().keywords}
      >
        {/* Why: the in-page removal toast points users to Settings > Mobile. */}
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.MobileSettingsPane.1de96ec8a6',
            'Show Dobius+ Mobile Button'
          )}
          description={translate(
            'auto.components.settings.MobileSettingsPane.d4f2b65f30',
            'Show the Dobius+ Mobile shortcut in the sidebar.'
          )}
          checked={showMobileButton}
          onChange={() => updateSettings({ showMobileButton: !showMobileButton })}
        />
      </SearchableSetting>

      {/* Why: the bridge reads chat.db and drives Messages.app, so it only
          exists on macOS; hide the section entirely elsewhere. */}
      {isMacUserAgent() ? <ImessageBridgeSetting /> : null}

      <div className="rounded-xl border border-border/60 bg-card/50 p-4">
        <MobilePane />
      </div>
    </div>
  )
}

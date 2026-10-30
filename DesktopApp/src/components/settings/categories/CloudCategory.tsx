import { useState } from 'react';
import { useStore } from '../../../store';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { PairingDialog } from '../../dialogs/PairingDialog';
import {
  BUTTON_CLASS, MONO_FIELD_CLASS, SettingsPage, SettingsRow, SettingsSection, Switch,
} from '../controls';

export function CloudCategory() {
  const remoteBridgeEnabled = useStore(s => s.remoteBridgeEnabled);
  const setRemoteBridgeEnabled = useStore(s => s.setRemoteBridgeEnabled);
  const allowRemoteSpawn = useStore(s => s.allowRemoteSpawn);
  const setAllowRemoteSpawn = useStore(s => s.setAllowRemoteSpawn);
  const cloudServiceUrl = useStore(s => s.cloudServiceUrl);
  const setCloudServiceUrl = useStore(s => s.setCloudServiceUrl);
  const [pairingOpen, setPairingOpen] = useState(false);

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.cloud.label} description={SETTINGS_CATEGORIES.cloud.description}>
      <SettingsSection label="Zdalne sterowanie">
        <SettingsRow
          label="Włącz zdalny most"
          labelId="settings-cloud-bridge"
          description="Wymaga restartu aplikacji."
        >
          <Switch checked={remoteBridgeEnabled} onChange={setRemoteBridgeEnabled} labelledBy="settings-cloud-bridge" />
        </SettingsRow>
        <SettingsRow label="Zezwól na zdalne wznawianie sesji" labelId="settings-cloud-spawn">
          <Switch checked={allowRemoteSpawn} onChange={setAllowRemoteSpawn} labelledBy="settings-cloud-spawn" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Połączenie">
        <SettingsRow label="Adres CloudService" htmlFor="settings-cloud-url">
          <input
            id="settings-cloud-url"
            type="text"
            value={cloudServiceUrl}
            onChange={e => setCloudServiceUrl(e.target.value)}
            placeholder="https://cloud.k8s.abeon.app"
            className={`${MONO_FIELD_CLASS} flex-[0_1_280px]`}
          />
        </SettingsRow>
        <SettingsRow label="Aplikacja mobilna">
          <button type="button" onClick={() => setPairingOpen(true)} className={BUTTON_CLASS}>
            Sparuj telefon
          </button>
        </SettingsRow>
      </SettingsSection>

      {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} />}
    </SettingsPage>
  );
}

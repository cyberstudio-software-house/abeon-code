import { useState } from 'react';
import { useStore } from '../../../store';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { PairingDialog } from '../../dialogs/PairingDialog';
import { SettingsPage } from '../controls';

function CloudTab() {
  const remoteBridgeEnabled = useStore(s => s.remoteBridgeEnabled);
  const setRemoteBridgeEnabled = useStore(s => s.setRemoteBridgeEnabled);
  const allowRemoteSpawn = useStore(s => s.allowRemoteSpawn);
  const setAllowRemoteSpawn = useStore(s => s.setAllowRemoteSpawn);
  const cloudServiceUrl = useStore(s => s.cloudServiceUrl);
  const setCloudServiceUrl = useStore(s => s.setCloudServiceUrl);
  const [pairingOpen, setPairingOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
          AbeonCloud (zdalne sterowanie)
        </label>
        <label className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
          <input
            type="checkbox"
            checked={remoteBridgeEnabled}
            onChange={e => setRemoteBridgeEnabled(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <div>
            <span className="text-[13px]">Włącz zdalny most</span>
            <p className="text-[11px] text-muted mt-0.5">
              Wymaga restartu aplikacji.
            </p>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
          <input
            type="checkbox"
            checked={allowRemoteSpawn}
            onChange={e => setAllowRemoteSpawn(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <div>
            <span className="text-[13px]">Zezwól na zdalne wznawianie sesji</span>
          </div>
        </label>
        <div className="mt-2">
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Adres CloudService
          </label>
          <input
            type="text"
            value={cloudServiceUrl}
            onChange={e => setCloudServiceUrl(e.target.value)}
            placeholder="https://cloud.k8s.abeon.app"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
          />
        </div>
        <button
          onClick={() => setPairingOpen(true)}
          className="mt-3 px-3 py-1.5 bg-fg text-bg text-[12px] font-medium"
        >
          Sparuj telefon
        </button>
      </div>

      {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} />}
    </div>
  );
}

export function CloudCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.cloud.label} description={SETTINGS_CATEGORIES.cloud.description}>
      <CloudTab />
    </SettingsPage>
  );
}

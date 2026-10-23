// The settings window (design lines 269-444): a rail with the signed-in user and the tabs, the tab's title with a "Saved" that shows when a change has been kept, and the tab.
// Administrators have two tabs more than members. On a phone the rail is a row of tabs under the title. Rendered by Explorer for as long as it is wanted: mounted
// means open (G12). `onMeChange` takes the signed-in user when their own name or preferences have changed.
// A change the server refuses is told to the window (`onFailed`) and not shown by whatever made it: a box saves when it is left, and the click that left it may have taken
// the admin to another user, so the place the answer was due is gone by the time it comes. It is a line over the tab, until it is dismissed or the next change is kept.

import { useState } from 'react';
import type { Me } from '../../../shared/types.ts';
import type { SettingsTab } from '../explorer/TitleBar.tsx';
import { Notice } from '../explorer/useFileActions.tsx';
import { roleName } from '../lib/settings.ts';
import { Avatar, Dialog } from '../ui/controls.tsx';
import { useFlash, useNarrow } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { GeneralTab } from './GeneralTab.tsx';
import { RecycleBinTab } from './RecycleBinTab.tsx';
import { UsersTab } from './UsersTab.tsx';

const TABS: [tab: SettingsTab, title: string, adminOnly: boolean][] = [['general', 'General', false], ['users', 'Users & access', true], ['trash', 'Recycle Bin', true]];

export function Settings({ me, tab, onTab, onClose, onMeChange, onSignOut }: {
  me: Me; tab: SettingsTab; onTab(tab: SettingsTab): void; onClose(): void; onMeChange(me: Me): void; onSignOut(): Promise<void>;
}) {
  const narrow = useNarrow();
  const [saved, flash] = useFlash(1500);
  const [failure, setFailure] = useState('');
  const kept = () => { setFailure(''); flash(); };   // a change was kept: "Saved", and a refusal that is still on show is over
  const tabs = TABS.filter(([, , adminOnly]) => me.role === 'admin' || !adminOnly);
  const [shown, title] = tabs.find(([key]) => key === tab) ?? tabs[0];   // a member is never on an administrator's tab

  const nav = (
    <nav aria-label="Settings" style={narrow
      ? { display: 'flex', gap: 2, padding: '0 12px 8px', overflowX: 'auto', flexShrink: 0 }
      : { width: 220, flexShrink: 0, padding: '20px 10px', display: 'flex', flexDirection: 'column', gap: 2, background: '#eef1f5', borderRight: '1px solid #e3e6eb' }}>
      {!narrow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 18px' }}>
          <Avatar id={me.id} name={me.displayName} size={36} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.displayName}</div>
            <div style={{ fontSize: 12, color: '#5c616b' }}>{roleName(me.role)}</div>
          </div>
        </div>
      )}
      {tabs.map(([key, name]) => <button key={key} type="button" className="set-tab" aria-current={key === shown ? 'page' : undefined} onClick={() => onTab(key)}>{name}</button>)}
    </nav>
  );

  return (
    <Dialog label="Settings" width={900} onClose={onClose} style={{ height: narrow ? '100%' : 620, background: '#f7f8fa' }}>
      <div style={{ display: 'flex', height: '100%' }}>
        {!narrow && nav}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: narrow ? '0 8px 0 16px' : '0 16px 0 28px' }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, whiteSpace: 'nowrap' }}>{title}</h2>
            <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#2f7d32', fontSize: 12 }}>{saved && <><Icon name="check" size={14} />Saved</>}</span>
            <div style={{ flex: 1 }} />
            <button type="button" className="bar-btn sq" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" size={12} /></button>
          </div>
          {narrow && nav}
          {failure && <Notice onDismiss={() => setFailure('')}>{failure}</Notice>}
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: narrow ? '0 16px 20px' : '0 28px 28px' }}>
            {shown === 'general' && <GeneralTab me={me} onMeChange={onMeChange} onSaved={kept} onFailed={setFailure} onSignOut={onSignOut} />}
            {shown === 'users' && <UsersTab me={me} onMeChange={onMeChange} onSaved={kept} onFailed={setFailure} />}
            {shown === 'trash' && <RecycleBinTab onFailed={setFailure} />}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

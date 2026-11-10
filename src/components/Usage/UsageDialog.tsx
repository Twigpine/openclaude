import * as React from 'react'
import { useState } from 'react'

import type { UsageTab } from '../../commands/usage/providerScreen.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { Pane } from '../design-system/Pane.js'
import { Tab, Tabs } from '../design-system/Tabs.js'
import { Usage as PlanUsage } from '../Settings/Usage.js'
import { LocalUsage } from './LocalUsage.js'

type Props = {
  onClose: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  initialTab: UsageTab
  /** Show the Plan tab (the provider reports plan limits). */
  showPlan: boolean
}

/**
 * `/usage`: local token usage for every provider, plus the provider's plan
 * limits where it reports them.
 */
export function UsageDialog({
  onClose,
  initialTab,
  showPlan,
}: Props): React.ReactNode {
  const [selectedTab, setSelectedTab] = useState<string>(
    showPlan ? initialTab : 'Local',
  )
  useExitOnCtrlCDWithKeybindings()
  useKeybinding(
    'confirm:no',
    () => onClose('Usage dialog dismissed', { display: 'system' }),
    { context: 'Settings' },
  )

  const tabs = [
    <Tab key="local" title="Local">
      <LocalUsage />
    </Tab>,
  ]
  if (showPlan) {
    tabs.push(
      <Tab key="plan" title="Plan">
        <PlanUsage />
      </Tab>,
    )
  }

  return (
    <Pane color="permission">
      <Tabs
        title="Usage"
        color="permission"
        selectedTab={selectedTab}
        onTabChange={setSelectedTab}
      >
        {tabs}
      </Tabs>
    </Pane>
  )
}

import * as React from 'react';
import { UsageDialog } from '../../components/Usage/UsageDialog.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { hasProviderPlanUsage, resolveInitialUsageTab } from './providerScreen.js';
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const showPlan = hasProviderPlanUsage();
  return <UsageDialog onClose={onDone} showPlan={showPlan} initialTab={resolveInitialUsageTab(args ?? '', showPlan)} />;
};

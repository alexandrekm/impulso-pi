export interface OpenCodeGoWindow {
  usagePercent: number;
  resetInSec: number;
}

export interface OpenCodeGoDashboardUsage {
  rolling: OpenCodeGoWindow | null;
  weekly: OpenCodeGoWindow | null;
  monthly: OpenCodeGoWindow | null;
}

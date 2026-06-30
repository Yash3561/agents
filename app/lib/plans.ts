export const PLAN_CONFIG: Record<string, { name: string; amount: number; trialDays: number }> = {
  spark: { name: "NeonPing Spark", amount: 29, trialDays: 7 },
  pulse: { name: "NeonPing Pulse", amount: 79, trialDays: 7 },
  surge: { name: "NeonPing Surge", amount: 199, trialDays: 7 },
};

export const PLAN_LIMITS: Record<string, number> = {
  free: 10,
  spark: 500,
  pulse: 2500,
  surge: 10000,
};

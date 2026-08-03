export function formatEstimatedAssistantCost(euroMicros: number): string {
  const euros = euroMicros / 1_000_000;
  if (euros > 0 && euros < 0.001) return "<€0.001";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
    maximumFractionDigits: 4,
  }).format(euros);
}

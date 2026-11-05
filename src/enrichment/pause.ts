// Global hold for background enrichment (e.g. while the PDF report is open): no step or AI job starts.
let held = false;

export const isEnrichmentHeld = () => held;

export function holdEnrichment(on: boolean) {
  held = on;
}

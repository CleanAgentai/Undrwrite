// Underwriting thresholds (percent LTV). One source for every gate, band and message.
// Values are the production rules: escalate above 80, auto-decline above 90 (FRANCO-Q2),
// flag 75–80 as the elevated band. Comparisons are strict (>), so exactly 80.0 does not escalate.
module.exports = {
  LTV_ESCALATION_PCT: 80,
  LTV_AUTO_DECLINE_PCT: 90,
  LTV_ELEVATED_BAND_PCT: 75,
};

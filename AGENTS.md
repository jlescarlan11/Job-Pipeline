# Production movement rule

- Never manually execute the production Alerter & Mover workflow or any of its
  nodes. Never invoke it through an API as a substitute for its schedule.
- Never manually copy or move business rows between `Scraped Jobs`, `To Review`,
  `To Apply`, `Applied Jobs`, or `Archive`.
- Repair the underlying data or code under a frozen, backed-up maintenance
  window, then wait for a scheduled Alerter & Mover execution to perform and
  verify copy-confirm-delete.
- A proven stale duplicate may be removed after a fresh backup and exact reread;
  deleting the invalid copy is not authorization to relocate the valid record.

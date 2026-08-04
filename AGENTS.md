# Production movement rule

- Manual execution of the production Alerter & Mover workflow is allowed when
  the operator deliberately requests it. A manual run must use the same guarded
  workflow path as a scheduled run.
- Never hard-copy, cut/paste, or otherwise manually relocate business rows
  between `Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, or `Archive`.
- Repair the underlying data or code under a frozen, backed-up maintenance
  window, then let Alerter & Mover perform and verify copy-confirm-delete.
- A proven stale duplicate may be removed after a fresh backup and exact reread;
  deleting the invalid copy is not authorization to relocate the valid record.

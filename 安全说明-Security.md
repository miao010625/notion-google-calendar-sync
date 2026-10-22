# Security and privacy

Keep integration tokens and account IDs in private Apps Script Script Properties.
Never commit a properties export, `.clasp.json`, `.clasprc.json`, or raw API logs.
Anyone you allow to edit your Apps Script project may be able to read its secrets.

For a security issue, use GitHub's private vulnerability reporting when available,
or contact the maintainer through their public GitHub profile to arrange a private
channel before sharing details. Do not publish private calendar information in an issue.

If a credential was accidentally exposed, revoke it with its provider and create
a replacement. Removing it from a later Git commit does not invalidate the old value.

Preview mode is the default. Live mode modifies only events owned by this installation.
Deletion is a separate opt-in and requires positive evidence of source archival.

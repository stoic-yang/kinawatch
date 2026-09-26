# Apple Reminders integration retired

The global floating task button, panel, API routes, frontend refresh logic,
Swift bridge source and installer have been removed from KinaWatch. Notes now
cover this workflow.

`GET /api/reminders` and `POST /api/reminders/action` return 404. Existing private
`reminders` configuration is ignored and cannot re-enable the integration.
KinaWatch no longer invokes the installed bridge or requests reminder access.

This removal does not modify Apple Reminders or iCloud lists and tasks. Existing
local operation receipts and any previously installed helper remain untouched;
they are not loaded or launched by KinaWatch. Ordinary Markdown task lists and
screen-time classification of the Apple Reminders app are unchanged.

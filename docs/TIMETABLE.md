# Timetable

The `#timetable` page shows the current/next course, today's classes, and a
Monday-first weekly grid. The diary sidebar links to it with the next class.
Academic weeks, room changes and explicit week lists are independent of the
journal's selected date and routine-day boundary. The campus timezone determines
today. After midnight the current week and upcoming lesson advance automatically;
clock updates run only in a visible document, without polling the API.

`GET /api/timetable` reads one local JSON file on demand, under the existing
same-origin and loopback checks. Default: `timetable.json` in `default_data_dir()`
(honoring `KINAWATCH_DATA_DIR`). Optional local configuration:
`{"timetable": {"file": "/your/private/timetable.json"}}`.
The backend never creates, imports, migrates or rewrites this file. There is no
upload/write endpoint. Personal schedules and PDFs must remain outside Git and
the static build; the example below is synthetic.

```json
{
  "version": 1,
  "term": "Example autumn term",
  "school": "Example campus",
  "timezone": "Asia/Shanghai",
  "week1_monday": "2026-09-14",
  "weeks": 16,
  "slots": [{"id": "am", "label": "1–2节", "start": "08:00", "end": "09:40"}],
  "courses": [{
    "id": "example-course-a", "name": "Example course", "teacher": "Teacher",
    "room": "Room A", "slot": "am", "weekday": 3,
    "weeks": [1, 3, 5], "weeks_label": "1–5周（单）"
  }],
  "exceptions": [],
  "sources": []
}
```

Each recurring course has an explicit list of teaching weeks; split rules when
the room changes. Slot IDs are unique and chronologically ordered, with disjoint
same-day `HH:MM` ranges. Week 1 must begin on a Monday. The reader validates the
bounded file and returns only recognized fields, excluding incidental personal
metadata. Missing files return `status: empty`; unreadable or invalid files return
`status: error`, with no write and no filesystem-path disclosure.

Date exceptions use `{"date": "YYYY-MM-DD", "follows": null, "label": "Holiday"}`
to cancel the day. For makeup classes, `follows` is the source course date. Its
weekday AND academic week select the courses, without recursively applying a
holiday on that source date. Only explicitly recorded holidays/makeup days are
applied; future notices and instructor changes require updating the private file.
`sources` may contain `{ "title": "Calendar", "url": "https://…" }` links.

Only one shared fetch is used by the diary and timetable page; revisiting either
or returning focus refreshes the file. A failed fetch labels the retained
snapshot. Invalid local data is shown as unavailable, not as a course-free day.
Overlapping course rules remain visible with a conflict label. Small viewports
scroll inside the weekly table while its time column remains fixed.

Verification: `python3 -m unittest discover -s tests -p 'test_timetable.py' -v`,
`npm run test:journal --prefix frontend`, production build, and read-only browser
checks of navigation, week transitions, makeup dates, themes and narrow widths.

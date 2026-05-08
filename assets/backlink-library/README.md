# Backlink Library

This directory contains the merged backlink library used by backlink-pilot.

Current merged sources:

- `/Users/Yuki/Desktop/外链整理目录.xlsx`
- `/Users/Yuki/Desktop/外链目录.xlsx`
- `kenchikuliu/backlink` `data/backlinks.json`
- DALUOSEO Google Sheet tabs from spreadsheet `1GSJRxpITbHjWz2edbCJlcabfZUiFgxMAVlROmee8UfQ`
- Existing remote sources from the local `backlink-library` Codex skill

Generated files:

- `backlink-library.csv`: final merged library
- `backlink-library-summary.md`: source and classification summary
- `backlink-library-coverage-2026-05-08.md`: coverage verification report
- `backlink-library-coverage-2026-05-08.json`: machine-readable coverage report

Coverage notes:

- `kenchikuliu/backlink`: all valid unique keys are included.
- DALUOSEO Google Sheet: all fetched unique keys are included.
- Source rows whose URLs are visibly truncated with `...` or `...` are skipped because they are not actionable URLs.

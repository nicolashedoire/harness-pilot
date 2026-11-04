from .cli import main

raise SystemExit(main())   # the exit code matters: `pilot update` runs the new code as `python -m maxxing ...`

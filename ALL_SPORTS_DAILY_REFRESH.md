# CURRENT: separate automatic daily predictions for all six sports

The previous combined daily workflow has been split into six independent GitHub Actions workflows. See `SEPARATE_DAILY_SPORT_WORKFLOWS.md` for the exact files, schedules, secrets and activation steps.

Each sport now has its own daily cron and its own manual `workflow_dispatch` recovery button:
Football, Basketball, Ice Hockey, Handball, Volleyball and Tennis.

Telegram Auto Picks remain a separate workflow at 08:25 WAT.

# Telegram Analyzer keyboard fix

Fixed a runtime ReferenceError where server.js called `telegramAiAnalysisKeyboard(...)` even though the imported helper is `telegramAiAnalyzerAnalysisKeyboard(...)`.

The fix updates all Analyzer result/replacement response paths to use the correct imported helper. Unsupported selections are still shown first, and the Replace Unsupported button only appears when unsupported legs exist.

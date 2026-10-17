# Toutiao protocol integration

Source: https://github.com/xc-2000/toutiao-auto-publisher
Commit: aa16d53be572582540dab593c5e5419bfaa8226b
License: MIT (see LICENSE).

Reused: article publishing, VOD video publishing, Chrome security runtime, HTTP QR login.
Adaptations: QR manager extracted without its separate account database; credentials stay in Studio encrypted accounts. Video Article import is type-only, using the host DTO. QR callback requires the official HTTPS domain. Runtime profiles and logs use isolated temporary directories. No upstream AI generation, application authentication or automatic posting scheduler is imported.

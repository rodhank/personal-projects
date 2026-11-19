# NOISE VISION

A website where the world is visible only while it moves (like MOTUS / Blindsight).
Open on a phone, allow the camera, and move. Tap the screen = PULSE.

- Camera → GPU optical flow (block matching) → the noise "sticks" to whatever moves.
- Standing still: pure static. A screenshot shows nothing.
- PULSE: an expanding ring lights edges (or real depth slices with "AI depth").
- Settings (⚙): mode (motion / classic MOTUS), sensitivity, object separation, grain, colors, AI depth, clap = pulse.

No app and no LiDAR needed; runs in Safari (iOS 15+, WebGL2).

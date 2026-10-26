# PRD: Shot Analysis Compare

## 1. Introduction / Overview

Shot Analysis in Trackman Performance Studio lets coaches and players review and analyse shots. Today's compare mode is too rigid. You cannot freely change how each shot is shown, swap one shot without breaking the pair, or show a session shot next to a shot from a historical session or a shot from the tour player library.

This prototype is an updated compare mode only. A coach or player puts two shots side by side, picks a view for each shot on its own, and replaces either shot from the current session, that player's history, or the tour library.

The layout should feel like Trackman, and it should not copy today's Shot Analysis screens. The Figma file is reference for how someone enters compare: the orange Compare button at the bottom of the shot list. That shell can be visible. Its other controls are not clickable.

## 2. Goals

- A coach or player can compare two shots from different places: this session, a past session, or the tour library.
- Each shot can use its own view at the same time (video, graph, trajectory, dispersion, data tiles, or table).
- Either shot can be swapped for another shot. The other shot, and both view choices, stay as they were.
- Compare opens with the left slot already filled and the right slot empty, so a tester can look at one shot and add the second.

## 3. User Stories

1. As a coach, I want a player's shot next to a tour library shot so I can show the difference in a lesson.
2. As a coach, I want video on one shot and any of the other views on the other so I can talk through the swing while supporting data stays in view.
3. As a player, I want to swap one shot for a shot from an earlier session so I can see track improvements and make comparisons to older shots. 
4. As a player, I want to be able to mix and match different views from the same shot such as trajectory on one side and dispersion on the other so I can check shape and landing together. 
5. As a coach, I want to try a new pairing quickly. Replacing one shot must not clear the other shot or reset the views.

## 4. Functional Requirements

1. The prototype opens already in compare mode for one player in the current session. It does not ask the user to sign in or pick a player.
2. The screen shows exactly two shot slots, side by side (left and right).
3. On open, the left slot shows the shot that is currently selected, if nothing is selected the latest one, and the right slot shows an empty slot that the user can easily populate.
4. Each slot shows the club, a short shot label, and a source: This session, History, or Tour. History also shows the session date. Tour also shows the tour player's name.
5. Each slot has its own view control. The options are Video, Graph, Trajectory, Dispersion, Data tiles, and Table.
6. Changing the view on one slot does not change the view on the other slot.
7. Each slot has a Change shot control that opens a shot list for that slot only.
8. The shot list has three sources:
  - **This session:** shots in the open session.
  - **History:** this player's past sessions, with the shots inside each session.
  - **Tour library:** reference shots from named tour players.
9. Each row in the list shows enough to choose: club, shot label, carry, and ball speed. History rows also show which past session they belong to. Tour rows show the tour player's name.
10. Choosing a shot replaces only that slot. The other slot stays. Both view choices stay.
11. The same shot may fill both slots, so a player can mix views of that shot. Choosing it again is allowed.
12. Closing the list without choosing leaves both slots unchanged.
13. **Video** shows a mock swing clip for that shot: a frame, play, and pause. A progress bar moves while it plays. No real video file is required.
14. **Graph** shows a 3D motion analysis (3DMA) view of that shot only: the player and the club in the swing, recognizable as 3DMA at a glance. 3DMA is its own feature. In this prototype it is only a view inside the slot. It does not change compare. There is no shared 3D scene, no overlay of the two swings, and no 3DMA tools (no joint editing, no metric picker, and no separate 3DMA screen). Choosing Graph on one slot does nothing to the other slot.
15. **Trajectory** shows a side view and a top view of that shot's ball flight, with carry and apex labeled. Shots that come from the shot tracker draw the real flight the radar measured, and the bounce and roll after landing. Mock shots draw a simple curve from carry, height and offline.
16. **Dispersion** shows a target and that shot's landing, with carry and offline. If the shot belongs to a session, other shots with the same club in that same session appear as lighter marks. A tour shot shows only that shot against the target.
17. **Data tiles** show the ball and club numbers for that shot, with units. The set is: ball speed (mph), launch angle (°), launch direction (°), spin rate (rpm), spin axis (°), carry (yd), total (yd), height (yd), landing angle (°), club speed (mph), attack angle (°), club path (°), face angle (°), face to path (°), dynamic loft (°), smash factor.
18. **Table** shows the same numbers as Data tiles, in a single list of label and value.
19. The header shows the product area (Shot Analysis), that this is compare, the player name, and the current session name and date.
20. All shots, sessions, and tour references are realistic mock data. Distances are in yards. Speeds are in mph. Names should sound like real players, not "Player 1" or "Shot A".
21. The prototype is desktop only.

## 5. Non-Goals (Out of Scope)

- Any Shot Analysis function that sits outside compare and does not feed the two slots. That includes single-shot review as its own mode, editing a shot, tagging, notes, reports, export, and share.
- More than two shots on screen at once.
- Saving a comparison, or sending it to someone.
- Search, filters, and sorting in the shot list.
- The 3DMA feature itself. Graph only shows a 3DMA view of the shot in that slot. It does not add 3DMA tools, a separate 3DMA screen, or any compare behavior.
- Real video files or a backend.
- Choosing which radar to use, or radar settings, beyond what the shot tracker component already offers.
- The rest of the Trackman UI/UX Game Engine, beyond the shot tracker.
- Sign-in, and switching which player is in focus.
- Phone and tablet layouts.
- Motion, other than the video progress bar while a mock clip is playing.
- Copying the layout of today's Trackman Performance Studio screens.

## 6. Design Considerations

The Figma file is reference only. The designer asked for a layout abstracted from current Shot Analysis designs.

- **Authoritative frames:** None.
- **Figma fidelity:** Not applicable. On-brand Trackman look. Original layout. Do not recreate today's compare screen.
- **Breakpoints in scope:** Desktop only.
- **Motion:** Off, except the mock video progress bar in requirement 13.

Visual direction:

- Light grey page, white slots, orange for the main actions and the selected view.
- Inter for labels and copy. Oswald for the big numbers (carry, ball speed, and the other tile values).
- The two slots are equal width. The view control and Change shot sit in the slot header so each shot reads as its own panel.
- The shot list opens over the slot it belongs to. The three sources are visible without leaving compare.
- Video, trajectory, and dispersion should be recognizable at a glance. Simple drawn graphics are enough. They do not need to be scientifically exact beyond the mock numbers on screen.
- Graph should read as 3D motion analysis for that one shot: a drawn player and club, not a line chart. A simple pose is enough. It does not need real 3D.
- Positive and negative coloring is not used to judge a shot. This screen compares. It does not score which shot is better.

## 7. Technical Considerations

- Static prototype: HTML, plain CSS, and JavaScript ES modules.
- Entry point is `index.html`. Styles live in `css/`. Behaviour lives in `js/`.
- Mock shots, sessions, and tour library live in `js/mockData.js`.
- No database, no API, and no sign-in.
- Serve the prototype over a local static server so ES modules load.
- Desktop layout only. Build for a wide window (about 1280px and up). It should also work for a non-widescreen setup.

### Shot tracker

The shot tracker is part of this prototype. It is the `<trackman-radar>` component from the Trackman UI/UX Game Engine docs, kept in `js/vendor/trackman-radar.js`. It connects to a Trackman 4 radar, and the browser must be Chromium-based (not Safari).

- Every shot the radar measures is added to the current session. It shows in the shot list and in the Change shot list under "Radar", and its source reads "This session · Shot tracker". The radar does not report which club was used, so these shots have no club.
- The shot appears once the radar has a carry for it. Later updates to the same shot replace its numbers.
- Radar values arrive in metres and m/s. The prototype converts them to yards and mph.
- The shot's numbers feed Data tiles, Table and Dispersion. Its flight feeds Trajectory, including bounce and roll. If the radar gives no usable flight, such as an indoor shot, Trajectory draws the simple curve instead.
- Mock shots stay in the prototype, so it works with no radar connected. It does not change how compare works, and it does not replace Video or Graph.

## 8. Success Metrics

This is a prototype for user testing, not a production release. Success means a coach or player can do the following without help:

- Tell which two shots are on screen, and where each one came from.
- Switch one slot to a different view and leave the other view as it is.
- Replace one shot with a shot from this session, then with a shot from history, then with a tour shot. The other shot and both views stay in place.
- After a tour library comparison, describe one difference they can see between the two shots.

## 9. Open Questions

1. **Resolved.** Two slots is the use case. Comparing more than two shots at once is out. This prototype builds two.
2. **Resolved.** Each shot shows its own numbers only. A difference versus the other shot can be added later from a debug menu. Do not build that menu until we have discussed how it works here.
3. **Resolved.** The same shot can fill both slots so a player can mix views of that shot. 


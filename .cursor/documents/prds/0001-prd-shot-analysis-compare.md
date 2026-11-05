# PRD: Shot Analysis Compare

## 1. Introduction / Overview

Shot Analysis in Trackman Performance Studio lets coaches and players review and analyse shots. Today's compare mode is too rigid. You cannot freely change how each shot is shown, swap one shot without breaking the pair, or show a session shot next to a shot from a historical session or a shot from the tour player library.

This prototype opens on one shot from Current session. That shot uses the same six views as Compare. Compare still has two slots. A coach or player puts two shots side by side, picks a view for each shot on its own, and replaces either shot from Current session, History, or Tour library.

The layout should feel like Trackman, and it should not copy today's Shot Analysis screens. The Figma file is reference for the opening screen: the shot list, and the orange Compare button at the bottom of it. Search is shown and cannot be used. Dark is the default look. Light is a choice in Prototype controls.

## 2. Goals

- A coach or player can review one shot with Video, Graph, Trajectory, Dispersion, Data tiles, or Table, then open Compare with that shot already in the left slot.
- A coach or player can compare two shots from different places: Current session, a past session, or Tour library.
- Each shot can use its own view at the same time.
- Either shot can be swapped for another shot. The other shot, and both view choices, stay as they were.
- Compare opens with the left slot already filled and the right slot empty, so a tester can look at one shot and add the second.

## 3. User Stories

1. As a coach, I want to review one shot with the same views I use in Compare, so I can look at it before I put it next to another shot.
2. As a coach, I want a player's shot next to a tour library shot so I can show the difference in a lesson.
3. As a coach, I want video on one shot and any of the other views on the other so I can talk through the swing while supporting data stays in view.
4. As a player, I want to swap one shot for a shot from an earlier session so I can see track improvements and make comparisons to older shots.
5. As a player, I want to be able to mix and match different views from the same shot such as trajectory on one side and dispersion on the other so I can check shape and landing together.
6. As a coach, I want to try a new pairing quickly. Replacing one shot must not clear the other shot or reset the views.

## 4. Functional Requirements

1. The prototype opens on one shot for Emma Walsh in the Range session on 26 Oct 2026. It does not ask anyone to sign in or pick a player. Dark is the default. The latest shot is selected. The shot list opens at the top.
2. The opening screen shows the full Current session list on the left, grouped by club, and the selected shot on the right. Compare sits at the bottom of the list. Search is on screen and cannot be used.
3. The one shot outside Compare uses the same six views as a Compare slot: Video, Graph, Trajectory, Dispersion, Data tiles, and Table. That view is its own. Compare does not copy it.
4. Compare shows exactly two slots, side by side. The header reads Shot Analysis · Compare, with Exit compare and Shot list. It also shows the player name and the session name and date. The opening screen header reads Shot Analysis, with the player and the session, and does not say Compare.
5. Each time Compare opens, the left slot is the shot selected in the list, on Trajectory, and the right slot is empty. The first shot added on the right opens on Data tiles. Exit compare goes back to the one shot, on the view that screen was already using. Opening Compare again starts the pair fresh.
6. A filled slot shows the club, a short shot label, and a source: Current session, History, or Tour. History also shows the session date. Tour also shows the tour player's name. A shot from the shot tracker reads Current session · Shot tracker, and the club is Radar.
7. Each filled slot has its own view control. Changing the view on one slot does not change the view on the other.
8. Each Compare slot has Change shot, which opens a list for that slot only. The sources are Current session, History, and Tour library.
9. History opens the session first. Each past session shows its name, date, shot count, and a short detail. Opening it shows that session's shots, grouped by club. Tour library opens the player first. Driver and Iron then open as their own groups, and both start closed. Chevrons mark the way into a session, a player, or a club group, and the way back (All sessions, All players). Shot rows do not have a triangle.
10. In Change shot, a shot row shows the club, the shot label, carry, and ball speed. The session or the tour player's name is the heading for that list, not repeated on every row.
11. Choosing a shot replaces only that slot. The other slot stays. Both view choices stay. The same shot may fill both slots. Closing the list without choosing leaves both slots unchanged.
12. The session shot list is the list on the opening screen and the Shot list in Compare. A Show control stays at the top of that list while the shots scroll. It chooses which parameter the row number is. Carry is the default. The unit comes after the number, such as 252 yd. The choices are the same parameters as Data tiles. Smash factor has no unit. Change shot does not use this control.
13. A video icon sits to the left of that number when the shot has a recording. In this Range session, Shot 8 and Shot 33 do not. Every other shot in that session does.
14. Choosing a row in the session shot list selects that shot. On the opening screen, the shot on the right updates. In Compare, the two slots stay as they are. The row you chose is the shot you see after Exit compare. If that row is already on screen, the list does not move. If it is above or below the rows you can see, only that list moves, just enough to bring the row into view. The rest of the page stays where it was.
15. Shot list in Compare opens the Current session list. The usual choice is a panel over Compare, and the two slots stay the same width. Prototype controls can switch it to a side column. The column slides in from the left and the slots get narrower. Close is an X. Prototype controls can show the X, the X and the word Close, or the word Close. Closing still does the same thing.
16. **Video** shows a mock swing clip when that shot has a recording: a frame, play, and pause. A progress bar moves while it plays. No real video file is required. **Graph** shows a 3D motion drawing of the player and the club for that shot only, when a recording exists. It does not change the other shot. There is no shared 3D scene, no overlay of the two swings, and no 3DMA tools. If there is no recording, Video and Graph both say "No video was recorded for this shot." Past sessions and Tour library have no recordings in this prototype. Shots from the shot tracker, and shots added with Take a new shot, have no recording either.
17. Prototype controls can hide shots with no video from the Compare lists only: Shot list, and Change shot on Current session. The opening screen still shows them. History and Tour library stay as they are. A shot already in a slot stays there.
18. **Trajectory** is a 3D range for that shot, not a side drawing and a top drawing. Carry and apex are written underneath. You can drag to look around the shot. The ball flies, then can bounce and roll after it lands. Each Trajectory view is its own range. Mock shots are drawn from carry, height, and how far offline they finished. A shot from the shot tracker uses the flight the radar measured when that flight is usable. If it is not, the range draws the shot from carry, height, and offline.
19. **Dispersion** shows a target and that shot's landing, with carry and offline. If the shot belongs to a session, other shots with the same club in that same session appear as lighter marks. A tour shot shows only that shot against the target.
20. **Data tiles** show the ball and club numbers for that shot, with units. The set is: ball speed (mph), launch angle (°), launch direction (°), spin rate (rpm), spin axis (°), carry (yd), total (yd), height (yd), landing angle (°), club speed (mph), attack angle (°), club path (°), face angle (°), face to path (°), dynamic loft (°), smash factor.
21. **Table** shows the same numbers as Data tiles, in a single list of label and value.
22. Prototype controls can show each shot's own numbers, or the difference versus the other shot. The difference is this shot minus the other shot. It appears only when both slots are on Data tiles or Table. It is not coloured as better or worse.
23. All shots, sessions, and tour references are realistic mock data. Distances are in yards. Speeds are in mph. Names should sound like real players, not "Player 1" or "Shot A".
24. The prototype is desktop only.
25. Prototype controls also cover the choices above: dark or light, chips or one joined view control, panel or side column, the Close styles, and hiding shots with no video. Take a new shot adds one Driver to Current session and selects it on the one-shot screen. It does not replace a shot already in a Compare slot. Reset all state returns the shots, views, and theme to the opening setup and removes shots added that way. The controls panel stays open.

## 5. Non-Goals (Out of Scope)

- Editing a shot, tagging, notes, reports, export, and share.
- More than two shots in Compare. The opening screen shows one shot. Three or more shots at once are out.
- Saving a comparison, or sending it to someone.
- Working search, filters, and sorting. The search box is visible and does nothing.
- The 3DMA feature itself. Graph only shows a 3D motion drawing of the shot in that slot. It does not add 3DMA tools, a separate 3DMA screen, or any compare behavior.
- Real video files or a backend.
- Choosing which radar to use, or radar settings, beyond what the shot tracker component already offers.
- The rest of the Trackman UI/UX Game Engine, beyond the shot tracker and the 3D range used for Trajectory.
- Sign-in, and switching which player is in focus.
- Phone and tablet layouts.
- Decorative motion. The video progress bar moves, Trajectory plays the ball on the range, and the side-column shot list slides in from the left.
- Copying the layout of today's Trackman Performance Studio screens.

## 6. Design Considerations

The Figma file is reference only. The designer asked for a layout abstracted from current Shot Analysis designs.

- **Authoritative frames:** None.
- **Figma fidelity:** Not applicable. On-brand Trackman look. Original layout. Do not recreate today's compare screen.
- **Breakpoints in scope:** Desktop only.
- **Motion:** The mock video progress bar, the ball flight on the 3D range, and the side column sliding in. Nothing else.

Visual direction:

- Dark is the default: a near-black page, dark slots, light text, and orange for the main actions and the selected view. Light, from Prototype controls, is a light grey page and white slots. The orange stays the same.
- Inter for labels and copy. Oswald for the big numbers (carry, ball speed, the other tile values, and the number on each shot row).
- The two slots are equal width until Shot list is a side column. Then they get narrower. The view control and Change shot sit in the slot header so each shot reads as its own panel.
- Change shot opens over the slot it belongs to. Current session, History, and Tour library are visible there without leaving Compare.
- The session shot list keeps Show at the top while the shots scroll. Carry is the number you see first. The unit follows the number. A video icon sits to the left of the number when that shot has a recording.
- Close is an X. The other Close styles are in Prototype controls.
- Chevrons are for list navigation. Shot rows do not have a triangle.
- Video, the 3D range, and dispersion should be recognizable at a glance. Graph should read as 3D motion for that one shot: a drawn player and club, not a line chart. A simple pose is enough.
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

- Every shot the radar measures is added to Current session. It shows in the shot list and in Change shot under Radar, and its source reads Current session · Shot tracker. The radar does not report which club was used, so these shots have no club.
- The shot appears once the radar has a carry for it. Later updates to the same shot replace its numbers.
- Radar values arrive in metres and m/s. The prototype converts them to yards and mph.
- The shot's numbers feed Data tiles, Table, and Dispersion. Trajectory is the 3D range (`golf-visualiser` in `js/vendor/engine/golf-visualiser.js`). When the radar has a usable flight, the range uses that flight. If it does not, the range draws the shot from carry, height, and offline. Mock shots are played the same way from their own numbers.
- A radar shot has no recording. Video and Graph say no video was recorded. Mock shots stay in the prototype, so it works with no radar connected. The tracker does not change how Compare works, and it does not replace Video or Graph.

## 8. Success Metrics

This is a prototype for user testing, not a production release. Success means a coach or player can do the following without help:

- On the opening screen, tell which shot is selected, switch its view, and see that the shot list number is Carry until they change Show.
- Press Compare, tell which shot is on the left, and see that the right side is empty.
- Switch one slot to a different view and leave the other view as it is.
- Replace one shot from Current session, then from History, then from Tour library. The other shot and both views stay in place. History starts at the session. Tour library starts at the player, then Driver and Iron.
- After a Tour library comparison, describe one difference they can see between the two shots.
- Choose a shot that is already on screen and see that the list stays put.

## 9. Open Questions

1. **Resolved.** Two slots is the use case. Comparing more than two shots at once is out. This prototype builds two. The opening screen is the one shot outside Compare.
2. **Resolved.** Prototype controls can show each shot's own numbers, or the difference versus the other shot. The difference shows only when both slots are on Data tiles or Table. It is this shot minus the other shot, and it is not coloured as better or worse.
3. **Resolved.** The same shot can fill both slots so a player can mix views of that shot.

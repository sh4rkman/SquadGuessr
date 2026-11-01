# <img src="https://img.shields.io/badge/-unreleased-888888?style=for-the-badge"> **Unreleased**

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added dots for existing and queued guesses on the review map, colour-coded by status, to spot repeats before export

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **2.2.0** *(2026-10-26)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added chat to the multiplayer lobby, with join/leave/kick notifications (by Hans-Vader in [#34](https://github.com/sh4rkman/SquadGuessr/pull/34))
- Added an option to keep the game code for subsequent rounds, and support for viewing results of finished games (by Hans-Vader in [#35](https://github.com/sh4rkman/SquadGuessr/pull/35))
- Added a last-seconds warning in the timer while a guess is still missing (by Hans-Vader in [#36](https://github.com/sh4rkman/SquadGuessr/pull/36))
- The lobby's join and watch links are now clickable (by Hans-Vader in [#37](https://github.com/sh4rkman/SquadGuessr/pull/37))
- Guests' ready status now resets when the host changes the settings (by Hans-Vader in [#38](https://github.com/sh4rkman/SquadGuessr/pull/38))
- Expanded the submission guide with detailed steps, a visibility toggle and upload instructions (by Hans-Vader in [#39](https://github.com/sh4rkman/SquadGuessr/pull/39))

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **2.1.0** *(2026-10-17)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added an optional automatic next round in multiplayer: a 5–30 s countdown after each reveal instead of waiting for the host's NEXT (by Hans-Vader in [#24](https://github.com/sh4rkman/SquadGuessr/pull/24))
- Added a rush timer option in multiplayer (5–30 s per round); "Timed" now shows its duration (by Hans-Vader in [#24](https://github.com/sh4rkman/SquadGuessr/pull/24))
- Added host handover: the host can make another player host from the lobby, and the first player back becomes host if the host stays on the results for 30 s (by Hans-Vader in [#24](https://github.com/sh4rkman/SquadGuessr/pull/24))
- Added ranking movement arrows on the reveal (▲ up, ▼ down) on phones and on the big screen (by Hans-Vader in [#25](https://github.com/sh4rkman/SquadGuessr/pull/25))
- Added a REJOIN hint on the menu and multiplayer screen to get back into a running game after dropping out (by Hans-Vader in [#26](https://github.com/sh4rkman/SquadGuessr/pull/26))
- Added a reset view button in the minimap zoom bar (by Hans-Vader in [#26](https://github.com/sh4rkman/SquadGuessr/pull/26))
- Added every existing guess position as a dot on the "Submit a guess" map, to spot the areas nobody covered yet

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- PLAY AGAIN no longer pulls everyone into the lobby: each player leaves the final ranking on their own (by Hans-Vader in [#24](https://github.com/sh4rkman/SquadGuessr/pull/24))
- Kicking a player and making someone host now ask for confirmation (by Hans-Vader in [#24](https://github.com/sh4rkman/SquadGuessr/pull/24))
- Players can now join during the start countdown (by Hans-Vader in [#26](https://github.com/sh4rkman/SquadGuessr/pull/26))
- Leaving the lobby asks for confirmation and tells the others who left (by Hans-Vader in [#26](https://github.com/sh4rkman/SquadGuessr/pull/26))
- Leaving during the start countdown or a game is no longer final: you can come back (by Hans-Vader in [#26](https://github.com/sh4rkman/SquadGuessr/pull/26))
- The multiplayer reconnect window is now 30 s (was 15 s), and a page left in the browser's back/forward cache no longer holds up the game (by Hans-Vader in [#26](https://github.com/sh4rkman/SquadGuessr/pull/26))
- Disabled Belaya and flooded Narva from maps list
- Removed deprecated references to /api/v2/ and API_KEY 



</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **2.0.0** *(2026-10-08)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added "Play with friends": join a session from your phone by code/QR, play synchronized rounds and find out who wins
- Added a big-screen view for projectors/TVs: WATCH with the session code instead of joining
- Added Docker Compose hosting (frontend + multiplayer server)
- Added "Submit a guess": paste a screenshot, choose its square, click where it was taken and download a ZIP to post on Discord
- Added a review page (menu SUBMIT A GUESS → REVIEW, or `?review`) to check submitted ZIPs and export the accepted guesses
- Multiplayer rounds start for everyone at the same moment, once every phone has loaded the images; the next round's images load in the background while you play
- Multiplayer guests can mark themselves ready; every start counts down (5 s when everyone is ready, 15 s when the host starts anyway) while all phones load the first round, and the host can call it off; the host can only start once at least one other player is there

</br><img src="https://img.shields.io/badge/-bug%20fix-firebrick">
- Fixed the timer never starting when a hint image fails to load; failed hint and map images are now retried

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **1.3.0** *(2026-02-19)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added a mention on hint images crediting the submitter (Thanks Dan)
- Added 23 new guess on Sanxian (Thanks Dan)
- Added a close button on full screen hint visualisation

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **1.2.1** *(2026-01-20)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added a Github link

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **1.2.0** *(2026-01-20)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added support for additional languages
- Added ZH locales

</br><img src="https://img.shields.io/badge/-bug%20fix-firebrick">
- Fixed weird page shifting on small screens

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **1.1.0** *(2026-01-09)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added a "Play Again" & "Share" buttons on results page
- Added a new page after game mode to select the timer wanted
- Added spacebar as a shortcut to guess/next/results buttons (thanks Snowflake)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **1.0.1** *(2026-01-09)*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- Map-name matching should be more permissive for maps with several words ("Kohat Toi" match "Kohat", "Black Coast" match "Blackcoast", ...)
- Added Debug helpers fonctions to help with submitting new guess (https://github.com/sh4rkman/SquadGuessr?tab=readme-ov-file#submit-a-new-guess)


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **1.0.0** *(2026-01-08)*

</br><img src="https://img.shields.io/badge/-new%20features-green"> Initial Beta release

</br></br><!-- CHANGELOG SPLIT MARKER -->
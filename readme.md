# vMenu Stream Deck

A Stream Deck plugin for controlling vMenu actions in FiveM.

## Installation

1. Copy the `com.huidev.vmenu.sdPlugin` folder to:

   ```text
   %APPDATA%\Elgato\StreamDeck\Plugins\
   ```

   The complete path should be:

   ```text
   %APPDATA%\Elgato\StreamDeck\Plugins\com.huidev.vmenu.sdPlugin
   ```

2. Copy the `sd_vmenu` folder to your FiveM server's resources directory. Add `ensure sd_vmenu` after `ensure vMenu` in `server.cfg`.

3. Completely close and restart the Stream Deck application, then start the FiveM resource.

4. Find **vMenu Stream Deck** in the Stream Deck action list.

## Updating an existing installation

1. Completely close Stream Deck and replace its installed `com.huidev.vmenu.sdPlugin` folder with this updated folder, including `pi/inspector.css` and `pi/inspector.js`.
2. Replace the server's `sd_vmenu` resource with this updated folder and run `restart sd_vmenu` in the server console.
3. Open Stream Deck again. Existing keys and selections can stay in place.

The property inspectors now use plain gray controls and compact label rows. Action names sent to FiveM use underscores (for example, `vehicle_extra`). Previously saved hyphenated names remain supported. The plugin also resolves each key using the action UUIDs in its manifest, so a new Vehicle Extra key no longer falls back to the saved-vehicle action.

## Development checks

From the folder containing both resources, run `node --test tests/actions.test.cjs tests/inspector.test.cjs`. These tests simulate key events, saving and reading back settings, and unavailable lists. Run `lua tests/client-appearance.test.lua` with Lua 5.4+ for tattoo and hair-overlay regressions. Confirm the actual vehicle, ped, and teleport behavior in a live FiveM session after installing.

## How to use

1. Drag a **vMenu Stream Deck** action onto a Stream Deck key.
2. Select the key to open its settings.
3. Choose the vehicle, ped, teleport, or vehicle extra you want to use.
4. Click **Save** and wait for **Saved.** Changes also save automatically when you change a selection. The confirmation appears only after Stream Deck reads back the stored settings.
5. Join your FiveM server.
6. Press the Stream Deck key to perform the selected action.

**Requires server to have https://github.com/RayHuiDev/sd_vmenu/ installed**

## Available actions

* Spawn Saved Vehicle
* Spawn Saved Ped
* Spawn Saved MP Ped
* Vehicle Extra
* Teleport Option

For vehicle extras, choose an extra from 1–12 and select **Toggle**, **Turn on**, or **Turn off**.

If a saved vehicle, ped, or teleport is missing, press **Refresh list** in the key’s settings.

A failed or empty refresh keeps your existing saved selection. If it is marked unavailable, save the item in vMenu and refresh, or choose a different item and click **Save**.

MP ped tattoos are decoded from vMenu's `Key`/`Value` entries; older collection-to-overlay maps are also supported. Invalid tattoo or hair-overlay values are skipped instead of being passed to `joaat`.

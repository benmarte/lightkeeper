# Changelog

## 1.0.4 (24 October 2026)

- **Over the app left open at power on.** When the TV switches on, Lightkeeper now also opens over the app that was in front when it went off, which webOS puts back. Before, a Homebrew Channel left open stayed in front. An app that comes up with the TV still stays in front, such as Netflix from its button, a cast from a phone or an alarm. An update while you use an app does not cover it. With nothing in front at first, Lightkeeper waits a few seconds for an app that is still starting: before, switching on with the Netflix button could end on Lightkeeper.
- **The background comes in whole.** The Home puts its picture on once it has loaded. Before, an uploaded picture came in at power on in strips over the app's own one (Godrevy) underneath.
- **A real gear** for the settings, Phosphor's, in place of the drawing that looked like a small sun.
- **Back from the last app on webOS 3** ([#3](https://github.com/chiotas/lightkeeper/issues/3)). Where LG has no Home app to come up, Lightkeeper watches the app in front: when an app gives way to nothing, as Back from the last one does, Lightkeeper opens, and again if Live TV comes up right after. Picking an input or Live TV with the remote does not count. Before, on webOS 3 the start-up hook asked every five seconds for app events that TV does not have. Built from a B7's logs (webOS 3.9.3), thank you Docproc; not yet tried on a webOS 3 TV. The Home key itself stays LG's there, and the Home entry 1.0.1 and 1.0.2 wrote in GlassHouse's key map, which nothing reads on webOS 3, is taken out.

## 1.0.3 (24 October 2026)

- **TV and media player icons for inputs** ([#4](https://github.com/chiotas/lightkeeper/issues/4)). Each input's device list now has a TV and a media player besides the game console and HDMI, so Live TV can go back to its TV icon and any input can use it.
- **Automatic**, first in each input's device list, lets you go back to no device picked. Live TV then shows a TV, and other inputs show what their tile's name suggests, the same in the settings as on the TV. A new input starts as Automatic: before, Live TV was given HDMI the moment it was added.

## 1.0.2 (24 October 2026)

- **Another port.** The settings can move to another port, under *Address*, or with `setup.sh --port` over SSH. When another program already has 8090, Lightkeeper takes the next free port, says so in its log and in the settings, and the gear on the TV shows the right address.
- **webOS 2 and 3** ([#1](https://github.com/chiotas/lightkeeper/issues/1), [#3](https://github.com/chiotas/lightkeeper/issues/3)). These TVs have no key filters for GlassHouse to use, so the Home key stays LG's. The settings now say so, instead of "Active within a minute" for good, and the README shows how to map a button with lginputhook.
- **Icons in the Home** ([#2](https://github.com/chiotas/lightkeeper/issues/2)). The HDMI plug, the TV, and the icons of LG's own apps (Browser, Gallery, Apps and others) showed in the settings but not on the TV: the Home's weather icons had the same name as the logos' table and replaced it.

## 1.0.1 (23 October 2026)

- **Icons only.** With logos or app icons, the names can now show under every tile, under the selected one only (smaller), or not at all. A line still marks the selected tile, and the names stay for screen readers and in the settings.
- **Up to fifty tiles**, from twelve. The Home draws the tiles' pictures as they come into view, so a long row stays quick on older TVs, and slides with the arrows. In the settings, tiles can be dragged by a handle on phones and computers; the arrows still work everywhere.
- **Updates leave nothing behind.** When the start-up hook starts again after an update, it now stops the old start's subscriptions, which stayed open for good, two more with every update.
- The gear has a name for screen readers.

## 1.0.0 (23 October 2026)

First release.

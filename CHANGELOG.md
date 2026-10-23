# Changelog

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
